# GraphDyVis / GraphVisualizer

代码驱动的图可视化 VS Code 扩展原型。当前仓库已经有可运行的 Extension + WebView 实现，不再是纯规划文档项目。

## 当前状态

已落地能力（与当前代码一致）：

- VS Code 命令：`GraphDyVis: Show A* Demo`、`GraphDyVis: Show Legacy Sample`
- WebView + D3 渲染（静态快照 + 事件回放）
- 交互：平移缩放、搜索聚焦、节点/边属性面板
- 回放控制：Play / Pause / Step / Reset / 速度调节（0.25x - 4x）
- 事件原因展示：支持 `reason`
- 协议校验：Host/WebView 消息与事件 JSON 均做运行时校验，非法输入安全忽略
- 样例校验脚本：校验 `data/` 中基线与 A* 事件流

## 目录与核心文件

- 插件入口：`src/extension.ts`
- WebView 前端：`webview/main.ts`
- WebView 样式：`media/webview.css`
- 消息契约：`src/protocol/contracts.ts`
- 事件协议与回放应用：`src/protocol/events.ts`
- 样例数据：`data/astar-sample-events.json`、`data/sample-events.json`
- 样例校验：`scripts/validate-samples.js`
- C++ 示例：`examples/cpp/graphdyvis_astar.hpp`、`examples/cpp/astar_demo.cpp`

## 本地开发

前置要求：Node.js 18+，VS Code。

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

检查：

```bash
npm run check
```

可选拆分命令：

```bash
npm run check:ts
npm run check:samples
npm run watch:extension
npm run watch:webview
```

调试扩展：

1. 在 VS Code 中按 `F5` 启动 Extension Development Host。
2. 在新窗口命令面板执行：`GraphDyVis: Show A* Demo`。

## 事件协议（schemaVersion = "1.0"）

源码真值：`src/protocol/events.ts`

顶层结构：

```json
{
  "schemaVersion": "1.0",
  "graph": {
    "nodes": [],
    "edges": []
  },
  "events": []
}
```

事件类型：

- `node_create`
- `edge_create`
- `edge_update`
- `edge_delete`

通用字段：

- 必填：`eventType`、`timestampMs`
- 可选：`reason`

兼容策略：

- 优先追加可选字段（additive）
- 未识别字段/事件类型由消费端安全忽略

## WebView 消息契约（contractVersion = "1.0"）

源码真值：`src/protocol/contracts.ts`

Host -> WebView：

- `init-data`
- `playback-state`
- `error`

WebView -> Host：

- `ready`
- `focus-request`
- `playback-control`（`play | pause | step | reset | set-speed`）

契约约束：

- 每条消息都有 `type`
- Host 消息固定携带 `contractVersion`
- 接收端先校验再更新状态

## 后续方向（非当前实现）

- 更大规模图的性能优化（在有测量瓶颈后再评估 WebGL）
- 更丰富的动态事件类型（如 prune / push-pop 语义）
- 更细粒度增量渲染与复杂交互策略