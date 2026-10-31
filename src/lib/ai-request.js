// Resolve an explicit quantity before submitting a potentially paid turn.
// Consume the complete numeric token: “12张” must never become “2张”.
export function resolveAiCount(selection, prompt) {
  const token = prompt.match(
    /(-?\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿萬億壹贰叁肆伍陆柒捌玖拾佰仟]+)\s*(?:张|个|幅|套)/,
  )?.[1];
  const chinese = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const value =
    selection === "自动"
      ? token === undefined
        ? 1
        : (chinese[token] ?? Number(token))
      : Number(selection);
  if (!Number.isInteger(value) || value < 1 || value > 3)
    throw new Error("每次创作支持 1–3 个方案，请调整数量或分次创作。");
  return value;
}
