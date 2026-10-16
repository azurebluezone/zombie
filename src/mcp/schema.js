export function validateToolArguments(tool, args) {
  const schema=tool?.inputSchema;
  if(!schema) return;
  if(schema.type && schema.type!=='object') throw new Error('mcp_tool_schema_unsupported');
  if(args===null || typeof args!=='object' || Array.isArray(args)) throw new Error('mcp_tool_arguments_must_be_object');
  for(const key of schema.required??[]) if(!(key in args)) throw new Error(`mcp_tool_argument_required:${key}`);
  const properties=schema.properties??{};
  for(const [key,val] of Object.entries(args)) {
    const p=properties[key];
    if(!p) {
      // `additionalProperties:false` is declared by every native tool schema. Gemini
      // cannot express that keyword in function declarations, so this boundary is the
      // only place where the constraint is enforced; without it a model could invent
      // arguments and the tool call would silently accept them.
      if(schema.additionalProperties===false) throw new Error(`mcp_tool_argument_unknown:${key}`);
      continue;
    }
    if(p.type==='string'&&typeof val!=='string') throw new Error(`mcp_tool_argument_type:${key}`); if(p.type==='number'&&typeof val!=='number') throw new Error(`mcp_tool_argument_type:${key}`); if(p.type==='integer'&&(!Number.isInteger(val))) throw new Error(`mcp_tool_argument_type:${key}`); if(p.type==='boolean'&&typeof val!=='boolean') throw new Error(`mcp_tool_argument_type:${key}`); }
}
