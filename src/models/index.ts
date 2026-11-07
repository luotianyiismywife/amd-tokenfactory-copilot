/**
 * index.ts — `src/models` 的公共出口（barrel）。
 *
 * 插件其他模块统一从 `"../models"` 导入模型信息，不直接依赖内部文件布局：
 *
 *   数据源        models.ts（内置清单）/ apiModelList.ts（/v1/models）/ modelsDev.ts
 *   能力判定      visionModels.ts
 *   归一化注册表  registry.ts        ← 单一事实来源
 *   形状适配      chatInfo.ts        ← VS Code 条目 / 请求体配置
 *   VS Code 入口  provideModel.ts
 *   启动同步      modelSync.ts
 */
export * from "./models";
export * from "./apiModelList";
export * from "./modelsDev";
export * from "./visionModels";
export * from "./registry";
export * from "./chatInfo";
export * from "./provideModel";
export * from "./modelSync";
