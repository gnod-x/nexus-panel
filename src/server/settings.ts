import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_HOME_FONT, isHomeFontId, type HomeFontId } from "../shared/home-fonts.js";

export class AppSettings {
  constructor(private readonly filename = process.env.NEXUS_SETTINGS_PATH || "/data/nexus-settings.json") {}

  getHomeFont(): HomeFontId {
    let contents: string;
    try {
      contents = fs.readFileSync(this.filename, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return DEFAULT_HOME_FONT;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(contents); } catch { throw new Error("Application settings file is invalid"); }
    if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
        !("homeFont" in value) || !isHomeFontId(value.homeFont)) throw new Error("Application settings file is invalid");
    return value.homeFont;
  }

  setHomeFont(homeFont: HomeFontId): void {
    const directory = path.dirname(this.filename);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = this.filename + "." + randomUUID() + ".tmp";
    let file: number | undefined;
    try {
      file = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(file, JSON.stringify({ version: 1, homeFont }) + "\n", "utf8");
      fs.fsyncSync(file);
      fs.closeSync(file);
      file = undefined;
      fs.renameSync(temporary, this.filename);
      const directoryFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } finally {
      if (file !== undefined) fs.closeSync(file);
      try { fs.unlinkSync(temporary); } catch { /* Renamed or absent. */ }
    }
  }
}
