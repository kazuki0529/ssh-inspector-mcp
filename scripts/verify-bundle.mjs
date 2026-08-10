import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ssh-inspector-bundle-"));
const bundlePath = join(temporaryDirectory, "ssh-inspector-mcp.mjs");

try {
  await copyFile(resolve("dist/ssh-inspector-mcp.mjs"), bundlePath);
  const result = await runNode(bundlePath);

  if (result.exitCode !== 1 || !result.stderr.includes("使用方法:")) {
    throw new Error(`bundle smoke testに失敗しました: exit=${String(result.exitCode)} stderr=${result.stderr}`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

/**
 * node_modulesのないdirectoryでbundleを起動し、module初期化結果を収集します。
 *
 * @param path 検証対象bundle
 * @returns process終了状態
 */
async function runNode(path) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [path], {
      cwd: temporaryDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (stdout.length > 0) {
        reject(new Error("bundleがJSON-RPC以外のstdoutを出力しました"));
        return;
      }
      resolveResult({ exitCode, stderr });
    });
  });
}