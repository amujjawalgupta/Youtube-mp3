const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 5000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const YTDLP_MODULE = process.env.YTDLP_MODULE || "yt_dlp";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const MAX_CONVERSIONS_PER_15_MIN = Number(process.env.MAX_CONVERSIONS_PER_15_MIN || 20);
const FILE_TTL_MS = Number(process.env.FILE_TTL_MS || 60 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
const DOWNLOAD_BASE_URL = process.env.DOWNLOAD_BASE_URL || "";
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

ensureDownloadsDirectory();

app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN
  })
);
app.use(express.json({ limit: "32kb" }));
app.use(morgan("combined"));

const conversionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: MAX_CONVERSIONS_PER_15_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many conversion requests. Please try again later."
  }
});

app.use("/downloads", express.static(DOWNLOADS_DIR, {
  maxAge: "1h",
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
}));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  const invocation = getYtDlpInvocation([]);
  res.json({
    ok: true,
    ytDlpCommand: invocation.command,
    ytDlpPrefix: invocation.args,
    ffmpegBinary: FFMPEG_BIN
  });
});

app.post("/convert", conversionLimiter, async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "No URL provided" });
  }

  if (!isAllowedYouTubeUrl(url)) {
    return res.status(400).json({ error: "Only youtube.com and youtu.be URLs are allowed" });
  }

  const jobId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  const baseArgs = [
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--no-playlist",
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate,
    url.trim()
  ];

  if (path.isAbsolute(FFMPEG_BIN)) {
    baseArgs.unshift("--ffmpeg-location", FFMPEG_BIN);
  }
  const invocation = getYtDlpInvocation(baseArgs);

  try {
    const result = await runYtDlp(invocation.command, invocation.args, jobId);

    if (!result.filePath) {
      return res.status(500).json({ error: "Conversion completed but output file was not found" });
    }

    const parsed = path.parse(result.filePath);
    const safeName = `${parsed.name}.mp3`;
    const canonicalPath = path.join(DOWNLOADS_DIR, safeName);

    if (canonicalPath !== result.filePath) {
      await fsp.rename(result.filePath, canonicalPath);
    }

    const downloadUrl = buildDownloadUrl(req, safeName);

    return res.status(200).json({
      message: "Download ready",
      download: downloadUrl
    });
  } catch (error) {
    const statusCode = error && error.statusCode ? error.statusCode : 500;
    return res.status(statusCode).json({
      error: error.message || "Conversion failed"
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Using yt-dlp binary: ${YTDLP_BIN}`);
  console.log(`Using ffmpeg binary: ${FFMPEG_BIN}`);
});

setInterval(() => {
  cleanupOldFiles(DOWNLOADS_DIR, FILE_TTL_MS).catch((error) => {
    console.error("Cleanup job failed:", error.message);
  });
}, CLEANUP_INTERVAL_MS).unref();

async function runYtDlp(command, args, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let outputPath = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;

      const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        const progressMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (progressMatch) {
          console.log(`[${jobId}] progress ${progressMatch[1]}%`);
        }

        if (line.endsWith(".mp3") && !line.includes("[download]")) {
          outputPath = line;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        return reject({
          statusCode: 500,
          message: `yt-dlp binary not found. Set YTDLP_BIN correctly.`
        });
      }

      return reject({
        statusCode: 500,
        message: `Failed to start converter process: ${error.message}`
      });
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        const errorText = stderr || stdout || "Unknown converter failure";
        return reject({
          statusCode: 502,
          message: sanitizeProcessError(errorText)
        });
      }

      try {
        const finalPath = await resolveOutputPath(outputPath, jobId);
        return resolve({ filePath: finalPath });
      } catch (error) {
        return reject({
          statusCode: 500,
          message: error.message || "Output file resolution failed"
        });
      }
    });
  });
}

function getYtDlpInvocation(conversionArgs) {
  const normalizedBin = String(YTDLP_BIN).trim().toLowerCase();
  const shouldUsePython = normalizedBin === "py" || normalizedBin === "python" || normalizedBin === "python3";

  if (shouldUsePython) {
    return {
      command: YTDLP_BIN,
      args: ["-m", YTDLP_MODULE, ...conversionArgs]
    };
  }

  return {
    command: YTDLP_BIN,
    args: conversionArgs
  };
}

async function resolveOutputPath(outputPath, jobId) {
  const normalized = outputPath ? outputPath.trim() : "";
  if (normalized) {
    const resolved = path.resolve(normalized);
    if (!resolved.startsWith(DOWNLOADS_DIR)) {
      throw new Error("Invalid output path returned by converter");
    }

    await fsp.access(resolved, fs.constants.F_OK);
    return resolved;
  }

  const entries = await fsp.readdir(DOWNLOADS_DIR);
  const prefix = `${jobId}.`;
  const match = entries.find((name) => name.startsWith(prefix));

  if (!match) {
    throw new Error("Converted output file not found");
  }

  return path.join(DOWNLOADS_DIR, match);
}

function buildDownloadUrl(req, fileName) {
  const encodedName = encodeURIComponent(fileName);
  if (DOWNLOAD_BASE_URL) {
    return `${DOWNLOAD_BASE_URL.replace(/\/$/, "")}/downloads/${encodedName}`;
  }

  return `${req.protocol}://${req.get("host")}/downloads/${encodedName}`;
}

function sanitizeProcessError(rawError) {
  const cleaned = String(rawError).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = cleaned[0] || "Conversion failed";
  return firstLine.slice(0, 220);
}

function isAllowedYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function ensureDownloadsDirectory() {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
}

async function cleanupOldFiles(directory, ttlMs) {
  const now = Date.now();
  const entries = await fsp.readdir(directory);

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry);
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) {
        return;
      }

      const age = now - stat.mtimeMs;
      if (age > ttlMs) {
        await fsp.unlink(fullPath);
        console.log(`Deleted old file: ${entry}`);
      }
    })
  );
}
