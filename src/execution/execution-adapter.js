export class ExecutionAdapter {
  constructor({provider,tool,mcp,loop=null}){this.provider=provider;this.tool=tool;this.mcp=mcp;this.loop=loop}
  async execute({prepared,input={},applicationId,context,onEvent}={}){
    const next={...input,applicationId,executionContext:context};
    if(next.autoToolLoop===true){if(!this.loop)throw new Error('tool_loop_not_connected');return this.loop.execute({prepared,input:next,applicationId,onEvent})}
    if(next.toolId)return this.tool.execute({prepared,input:next,applicationId,context});
    if(next.qualifiedName||next.executionTarget==='mcp')return this.mcp.execute({prepared,input:next,applicationId,context});
    return this.provider.execute({prepared,input:next,applicationId,context});
  }
}
