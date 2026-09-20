"use strict";
const id = { type: "integer", minimum: 1, description: "ID returned by Photoshop; never guess an ID." };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const tools = [
  { name: "photoshop_capabilities", description: "Check the live Photoshop connection and available operations. No document or pixels are changed.", inputSchema: schema({}) },
  { name: "photoshop_get_document", description: "Read the current Photoshop document, open documents, dimensions, mode, layer count and selected layer IDs. Use before other Photoshop tools to bind their documentId.", inputSchema: schema({}) },
  { name: "photoshop_list_layers", description: "Read the real layer tree as paginated rows with parent IDs, nesting depth, names, kinds, visibility, opacity, blend mode and bounds. Does not change Photoshop.", inputSchema: schema({ documentId: id, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["documentId"]) },
  { name: "photoshop_get_layer", description: "Read one real layer's properties and text content, if it is a text layer. Requires a layer ID from photoshop_list_layers.", inputSchema: schema({ documentId: id, layerId: id }, ["documentId", "layerId"]) },
  { name: "photoshop_get_selection", description: "Read the current Photoshop selection bounds or report that no selection exists. This returns metadata, not image pixels.", inputSchema: schema({ documentId: id }, ["documentId"]) },
  { name: "photoshop_render_preview", description: "Read actual current Photoshop pixels as an image, either the document composite or one specified layer. Use when the user asks to look at the current canvas or visually inspect a layer. Captures fresh pixels each time; does not save or edit the document.", inputSchema: schema({ documentId: id, layerId: id, maxEdge: { type: "integer", minimum: 128, maximum: 1024 } }, ["documentId"]) },
  { name: "photoshop_select_layers", description: "Locate/select the specified existing layers in the current Photoshop document. Changes only the active layer selection, never layer contents, visibility, names or pixels. Use when the user asks to locate or select a layer.", inputSchema: schema({ documentId: id, layerIds: { type: "array", items: id, minItems: 1, maxItems: 20, uniqueItems: true } }, ["documentId", "layerIds"]) },
].map(tool => ({ ...tool, annotations: { readOnlyHint: tool.name !== "photoshop_select_layers", destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

function validate(name, args) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error("不支持这个 Photoshop 工具");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
  const s = tool.inputSchema;
  for (const key of Object.keys(args)) if (!Object.hasOwn(s.properties, key)) throw new Error("不支持参数：" + key);
  for (const key of s.required) if (args[key] == null) throw new Error("缺少参数：" + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = s.properties[key];
    if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.minimum || (rule.maximum && value > rule.maximum))) throw new Error("参数无效：" + key);
    if (rule.type === "array" && (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems || new Set(value).size !== value.length || value.some(n => !Number.isInteger(n) || n < 1))) throw new Error("图层编号列表无效");
  }
  return { ...args };
}
module.exports = { tools, validate };
