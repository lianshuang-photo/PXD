import { useMemo } from "react";
import type { PresetMeta } from "../services/presets";

interface Props {
  presets: PresetMeta[];
  value: string;
  onChange: (fileName: string) => void;
}

interface PresetGroup {
  key: string;
  label: string;
  presets: PresetMeta[];
}

const PresetCatalogSelect = ({ presets, value, onChange }: Props) => {
  const groups = useMemo(() => {
    const grouped = new Map<string, PresetGroup>();
    for (const preset of presets) {
      const source = preset.isFactory ? "factory" : "user";
      const category = preset.category || "未分类";
      const key = `${source}:${category}`;
      const existing = grouped.get(key);
      if (existing) existing.presets.push(preset);
      else grouped.set(key, {
        key,
        label: `${preset.isFactory ? "出厂" : "我的"} · ${category}`,
        presets: [preset]
      });
    }
    return Array.from(grouped.values());
  }, [presets]);
  const selected = presets.find((preset) => preset.fileName === value) ?? null;

  return (
    <div className="preset-catalog-select">
      <select
        className="input"
        value={value}
        aria-label="预设目录"
        onChange={(event) => onChange(event.target.value)}
      >
        {!presets.length && <option value="">选择预设</option>}
        {groups.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.presets.map((preset) => (
              <option key={preset.fileName} value={preset.fileName}>
                {preset.subCategory ? `${preset.subCategory} / ` : ""}{preset.name}
                {preset.isFactory ? " [只读]" : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {selected && (
        <span
          className={selected.isFactory ? "preset-kind-badge preset-kind-badge--factory" : "preset-kind-badge"}
          title={selected.isFactory ? "随插件提供，只能另存为用户预设" : "保存在用户预设目录"}
        >
          {selected.kind === "gemini" ? "Gemini" : "Forge"}
          {selected.isFactory ? " · 只读" : ""}
        </span>
      )}
    </div>
  );
};

export default PresetCatalogSelect;
