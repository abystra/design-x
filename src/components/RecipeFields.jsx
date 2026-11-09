import React from "react";

export default function RecipeFields({
  recipe,
  recipeParameters,
  setRecipeParameters,
  results,
  selectedResult,
}) {
  if (!recipe) return null;
  return (
    <fieldset className="st-recipe-fields">
      <legend>{recipe.name} · 结构化参数</legend>
      {recipe.id === "multi-size" && (
        <label>
          <span>原画板</span>
          <select
            aria-label="多尺寸适配原画板"
            value={
              recipeParameters.documentId ||
              (selectedResult?.kind !== "image"
                ? selectedResult?.documentId || selectedResult?.id
                : "") ||
              ""
            }
            onChange={(event) =>
              setRecipeParameters((previous) => ({
                ...previous,
                documentId: event.target.value,
              }))
            }
          >
            <option value="">选择可编辑画板</option>
            {results
              .filter((item) => item.kind !== "image")
              .map((item) => (
                <option key={item.id} value={item.documentId || item.id}>
                  {item.title} · V{item.revision}
                </option>
              ))}
          </select>
        </label>
      )}
      {(recipe.id === "multi-size"
        ? []
        : [
            ["headline", "标题", "独立文字图层"],
            ["subheadline", "副标题", "可选"],
            ["cta", "行动文案", "例如：立即探索"],
            ["brand", "品牌名称", "可选"],
          ]
      ).map(([key, label, placeholder]) => (
        <label key={key}>
          <span>{label}</span>
          <input
            value={recipeParameters[key] || ""}
            maxLength={
              key === "cta"
                ? 60
                : key === "brand" || key === "headline"
                  ? 80
                  : 160
            }
            placeholder={placeholder}
            onChange={(event) =>
              setRecipeParameters((previous) => ({
                ...previous,
                [key]: event.target.value,
              }))
            }
          />
        </label>
      ))}
      {recipe.id === "multi-size" && (
        <label>
          <span>目标尺寸</span>
          <input
            value={recipeParameters.sizes || "600x800,800x800,960x540"}
            placeholder="600x800,800x800"
            onChange={(event) =>
              setRecipeParameters((previous) => ({
                ...previous,
                sizes: event.target.value,
              }))
            }
          />
        </label>
      )}
      {!recipe.enabled && (
        <p role="status">{recipe.reason || "该配方尚未配置"}</p>
      )}
    </fieldset>
  );
}
