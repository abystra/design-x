import React, { type CSSProperties } from "react";
import type { Artboard, DesignNode } from "../../doc-core/src/index";

export const DOCUMENT_FONT =
  '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif';
export const documentCss = `*{box-sizing:border-box}html,body{margin:0;padding:0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.dx-artboard{position:relative;overflow:hidden;isolation:isolate}.dx-document-node{position:absolute;box-sizing:border-box;transform-origin:center center}.dx-node-image{width:100%;height:100%;display:block;pointer-events:none}.dx-node-text{width:100%;height:100%;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15;margin:0;padding:0}`;
export function nodeStyle(n: DesignNode): CSSProperties {
  return {
    position: "absolute",
    left: n.x,
    top: n.y,
    width: n.w,
    height: n.h,
    opacity: n.opacity ?? 1,
    display: n.hidden ? "none" : undefined,
    transform: n.rotation ? `rotate(${n.rotation}deg)` : undefined,
    transformOrigin: "center center",
    boxSizing: "border-box",
  };
}
export function NodeContent({
  node: n,
  resolveAsset = (src: string) => src,
}: {
  node: DesignNode;
  resolveAsset?: (src: string) => string;
}) {
  if (n.type === "image")
    return (
      <img
        className="dx-node-image"
        src={resolveAsset(n.src || "")}
        alt={n.label || ""}
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          objectFit: n.fit || "cover",
          objectPosition: n.objectPosition || "50% 50%",
          pointerEvents: "none",
        }}
      />
    );
  if (n.type === "text")
    return (
      <div
        className="dx-node-text"
        lang="zh-CN"
        style={{
          fontFamily: n.font?.includes("Georgia")
            ? '"Source Serif 4 Variable", serif'
            : DOCUMENT_FONT,
          fontSize: n.size || 24,
          fontWeight: n.weight || 400,
          color: n.color || "#292b2e",
          textAlign: n.align || "left",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          lineHeight: 1.15,
          width: "100%",
          height: "100%",
          margin: 0,
          padding: 0,
        }}
      >
        {n.text}
      </div>
    );
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${n.w} ${n.h}`}
      style={{ display: "block", overflow: "visible" }}
    >
      {n.type === "circle" ? (
        <ellipse
          cx={n.w / 2}
          cy={n.h / 2}
          rx={n.w / 2}
          ry={n.h / 2}
          fill={n.color || "#000"}
        />
      ) : (
        <rect width={n.w} height={n.h} fill={n.color || "#000"} />
      )}
    </svg>
  );
}
export function ArtboardRenderer({
  design,
  transparent = false,
  resolveAsset,
}: {
  design: Artboard;
  transparent?: boolean;
  resolveAsset?: (src: string) => string;
}) {
  return (
    <div
      className="dx-artboard"
      style={{
        position: "relative",
        overflow: "hidden",
        width: design.width,
        height: design.height,
        background: transparent ? "transparent" : design.background,
      }}
    >
      {design.nodes.map((n) => (
        <div
          key={n.id}
          data-node-id={n.id}
          className="dx-document-node"
          style={nodeStyle(n)}
        >
          <NodeContent node={n} resolveAsset={resolveAsset} />
        </div>
      ))}
    </div>
  );
}
