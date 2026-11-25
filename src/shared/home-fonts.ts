export const HOME_FONT_IDS = ["calligraphy", "sans", "serif", "kai"] as const;

export type HomeFontId = typeof HOME_FONT_IDS[number];

export const DEFAULT_HOME_FONT: HomeFontId = "calligraphy";

export function isHomeFontId(value: unknown): value is HomeFontId {
  return typeof value === "string" && (HOME_FONT_IDS as readonly string[]).includes(value);
}

export const HOME_FONTS: Record<HomeFontId, { label: string; family: string }> = {
  calligraphy: { label: "柳体", family: '"Liu Jian Mao Cao", "Kaiti SC", "KaiTi", "STKaiti", serif' },
  sans: { label: "黑体", family: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif' },
  serif: { label: "宋体", family: '"Songti SC", "SimSun", "Noto Serif CJK SC", serif' },
  kai: { label: "楷体", family: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif' },
};
