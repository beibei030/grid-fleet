import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");

/** 进程级单实例锁，防止多开导致重复自动开仓 */
export function acquireSingleInstance(lockName = "hedge.pid"): void {
  const lockFile = path.join(DATA_DIR, lockName);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(lockFile)) {
    const prev = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    if (prev > 0 && prev !== process.pid) {
      try {
        process.kill(prev, 0);
        log.error(`已有实例运行 (PID ${prev}, ${lockName})，本进程退出以防多开叠仓`);
        process.exit(1);
      } catch {
        log.warn(`清除过期 PID 锁 (原 PID ${prev}, ${lockName})`);
        fs.unlinkSync(lockFile);
      }
    }
  }

  fs.writeFileSync(lockFile, String(process.pid));
  const release = () => {
    try {
      if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
}
