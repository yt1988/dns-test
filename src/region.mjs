// Country and region names, and flags, the way 1ms-shell docs/tool-contract.md §5 asks: the visitor's language through
// Intl.DisplayNames, except Taiwan (TW), which has a fixed name in every language and the cn flag.
const TW = { "zh-CN": "中国台湾", "zh-TW": "中國台灣", en: "Taiwan, China", ja: "中国台湾", ko: "중국 대만", es: "Taiwán, China", fr: "Taïwan, Chine", de: "Taiwan, China", pt: "Taiwan, China", ru: "Тайвань, Китай" };
export const regionName = (cc, lang) => cc === "TW" ? (TW[lang] || TW.en) : new Intl.DisplayNames([lang], { type: "region" }).of(cc);
export const flagCode = cc => cc === "TW" ? "cn" : cc.toLowerCase();   // /flags/${flagCode(cc)}.svg
