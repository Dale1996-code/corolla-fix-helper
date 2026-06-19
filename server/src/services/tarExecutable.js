import fsDefault from "node:fs";
import path from "node:path";

export function resolveTarExecutable({
  platform = process.platform,
  env = process.env,
  fs = fsDefault,
} = {}) {
  if (platform !== "win32") {
    return "tar";
  }

  const systemRoot = env.SystemRoot || env.SYSTEMROOT;

  if (systemRoot) {
    const nativeTar = path.win32.join(systemRoot, "System32", "tar.exe");

    if (fs.existsSync(nativeTar)) {
      return nativeTar;
    }

    throw new Error(`Native Windows tar.exe was not found at ${nativeTar}.`);
  }

  const systemDrive = env.SystemDrive || env.SYSTEMDRIVE || "C:";
  const fallbackTar = path.win32.join(
    `${systemDrive}\\`,
    "Windows",
    "System32",
    "tar.exe"
  );

  if (fs.existsSync(fallbackTar)) {
    return fallbackTar;
  }

  throw new Error(
    `Native Windows tar.exe was not found. SystemRoot is not set and ${fallbackTar} does not exist.`
  );
}
