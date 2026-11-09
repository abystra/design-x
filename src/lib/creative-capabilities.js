import { useEffect, useState } from "react";
import { api } from "./api";

// The server is authoritative; absent configuration never implies availability.
export function modeId(mode) {
  if (["image", "图片生成"].includes(mode)) return "image";
  if (["video", "视频生成", "视频"].includes(mode)) return "video";
  if (
    mode == null ||
    ["design", "Agent", "智能创作", "可编辑设计"].includes(mode)
  )
    return "design";
  return mode;
}
export function modeLabel(mode) {
  return (
    { design: "可编辑设计", image: "图片生成", video: "视频生成" }[
      modeId(mode)
    ] || mode
  );
}
export function useCapabilities() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api("/capabilities")
        .then((value) => {
          if (active) {
            setCatalog(value);
            setError("");
          }
        })
        .catch((failure) => {
          if (active) setError(failure.message);
        });
    refresh();
    window.addEventListener("designx:refresh", refresh);
    return () => {
      active = false;
      window.removeEventListener("designx:refresh", refresh);
    };
  }, []);
  return { catalog, error, loading: !catalog && !error };
}
export function capabilityFor(catalog, mode) {
  return catalog?.modes?.find((item) => item.id === modeId(mode));
}
export function imageSize(ratio) {
  if (["1024x1024", "1024x1536", "1536x1024"].includes(ratio)) return ratio;
  return ["3:4", "9:16"].includes(ratio)
    ? "1024x1536"
    : ["16:9", "4:3"].includes(ratio)
      ? "1536x1024"
      : "1024x1024";
}
export function normalizeAsset(asset) {
  const assetId = asset.assetId || (asset.status ? asset.id : undefined);
  const versionId = asset.assetVersionId || asset.versionId;
  return {
    ...asset,
    assetId,
    versionId,
    name: asset.title || asset.name,
    url:
      assetId && versionId
        ? `/api/assets/${assetId}/versions/${versionId}/file`
        : asset.image || asset.url,
  };
}
export function recipeFor(catalog, skill) {
  if (!skill) return null;
  return (
    catalog?.recipes?.find(
      (item) =>
        item.id === (skill.recipeId || skill.id) || item.name === skill.name,
    ) || null
  );
}
