import type { APIRoute } from "astro";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const prerender = false;

const PYTHON =
  process.env.PYTHON_PATH ??
  "C:\\Users\\Faraz\\AppData\\Local\\Programs\\Python\\Python315\\python.exe";

const MAX_BYTES = 100 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const ALLOWED_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "redd.it",
  "www.redd.it",
  "v.redd.it",
]);

function validRedditUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
      url.pathname === "/" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  let body: { url?: unknown };

  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body.", { status: 400 });
  }

  const url = validRedditUrl(body.url);

  if (!url) {
    return new Response("Provide a valid HTTPS Reddit video URL.", {
      status: 400,
    });
  }

  let tempDir: string | undefined;

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "redditsave-"));

    const outputTemplate = path.join(tempDir, "video.%(ext)s");

    const child = spawn(
      PYTHON,
      [
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--no-warnings",
        "--max-filesize",
        "100M",
        "--format",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format",
        "mp4",
        "--output",
        outputTemplate,
        "--",
        url.href,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );

    let stderr = "";
    let timedOut = false;

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, TIMEOUT_MS);

      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });

      child.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once("close", (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    if (timedOut) {
      return new Response("Video retrieval timed out. Please try again.", {
        status: 504,
      });
    }

    if (exitCode !== 0) {
      console.error("yt-dlp failed:", stderr);

      return new Response(
        "Video retrieval failed. The video may be unavailable or unsupported.",
        { status: 502 },
      );
    }

    const files = await readdir(tempDir);
    const videoFile = files.find((file) =>
      file.toLowerCase().endsWith(".mp4"),
    );

    if (!videoFile) {
      return new Response("No MP4 video was produced.", { status: 502 });
    }

    const filePath = path.join(tempDir, videoFile);
    const fileInfo = await stat(filePath);

    if (fileInfo.size === 0) {
      return new Response("No video data was returned.", { status: 502 });
    }

    if (fileInfo.size > MAX_BYTES) {
      return new Response("Video exceeds the 100 MB limit.", {
        status: 413,
      });
    }

    const video = await readFile(filePath);

    return new Response(new Uint8Array(video), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="reddit-video.mp4"',
        "Content-Length": String(video.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    console.error("RedditSave error:", error);

    return new Response("Video retrieval failed due to a server error.", {
      status: 500,
    });
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(
        (error: unknown) => console.error("Temporary cleanup failed:", error),
      );
    }
  }
};