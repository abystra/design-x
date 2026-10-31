import React, { useLayoutEffect, useRef, useState } from "react";
import { ArtboardRenderer } from "../../packages/doc-render/src/render";
import "./design-thumbnail.css";

export default function DesignThumbnail({ design, title, style }) {
  const host = useRef(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setBox({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(box.width / design.width, box.height / design.height);
  return (
    <div
      ref={host}
      className="dx-design-thumbnail"
      role="img"
      aria-label={`${title || "设计"}预览`}
      style={{ background: design.background, ...style }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: (box.width - design.width * scale) / 2,
          top: (box.height - design.height * scale) / 2,
          width: design.width,
          height: design.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          pointerEvents: "none",
        }}
      >
        <ArtboardRenderer design={design} />
      </div>
    </div>
  );
}
