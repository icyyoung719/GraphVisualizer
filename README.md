# GraphDyVis - 图算法可视化工具
## 🎯 目标

- 提供一个 代码驱动 的图形可视化工具，用于展示 图算法（如 DAG 最短路径算法）的执行过程。
- 支持 静态图 与 动态图 两种模式，满足算法调试与流程分析需求。
- 集成到 VS Code 插件 前端，开发环境内即可查看可视化结果。
---
## 🔒 硬性要求
- 代码控制：节点位置、布局由算法自动计算，不依赖手动微调。
- 高性能：支持大量节点与边的渲染，保证清晰度与交互流畅度。
- 动态图支持：可视化容器操作（push/pop）、剪枝、边更新等过程。
---
## 🌟 扩展功能（最好有）
- 交互操作：在代码控制的基础上，允许用户手动调整节点，操作结果可回写到代码。
- 搜索与定位：快速查找节点或边，自动聚焦。
- 智能放缩与焦点处理：
    ◦ 同层节点自动浅色化，突出焦点。
    ◦ 用户可指定显示策略（默认隐藏部分数据，鼠标悬停时展开）。
- 节点合并：若同一节点出发的若干子节点后续完全相同，可合并显示为一组。
- 视野优化：对屏幕外的部分进行特殊处理（折叠、简化渲染）。
- 属性显示与样式映射：
    ◦ 支持条件样式（如 A>50 → 红色，关键节点连线 → 蓝色）。
    ◦ 点击节点/边可显示详细属性与事件信息。
- 热更新：数据更新后，能自动或手动刷新，重新渲染图。如果可能，可以支持增量渲染，仅更新变化的节点与边，避免全量重绘
---
## ⚡ 性能优化策略
- GPU 加速：利用并行计算提升布局与渲染效率。
- 分层渲染：优先绘制焦点区域，延迟加载外围节点。
- 事件流驱动：通过日志/事件流记录算法过程，按需回放。
---
## 🖥️ 架构设计
### 1. 三方代码库（GraphDyVis）
提供 C++ 接口，开发者在算法代码中直接调用：
```cpp
#include <graphDyVis>

GraphDyVis vis;
vis.create_node(id, name, property);
vis.create_edge(id, name, property);
vis.update_edge(id, newProperty, reason);  // reason 显示在事件窗口或 toast
vis.delete_edge(...);

GraphVis staVis;   // 静态图（可替换为动态）2. VS Code 插件前端
```

**技术细节与选择**：

主要提供一个接口，供算法代码调用。可以设计成一个轻量级的库，因为只是用于输出信息，而不涉及具体的渲染逻辑。

cpp17，多使用现代特性，不要滥用智能指针

这部分代码库不是特别的重要

### 2. 插件前端
- WebView 渲染层：基于 D3.js / Cytoscape.js / WebGL 渲染。
- 交互功能：搜索、定位、缩放、属性展示。
- 事件窗口：显示 update/delete 等操作的原因与上下文。

**技术细节与选择**：
- 先使用D3.js实现基本功能，后续根据性能需求考虑WebGL方案。交互功能可以逐步迭代开发，先实现基本的搜索和属性展示、静态图功能，再逐步增加动态交互和事件窗口功能。

**进阶细节**：
- 命令面板集成：如 Ctrl+Shift+P → Show DAG Visualization。
- 双向通信通道：通过 vscode.postMessage() 实现前后端事件同步。
- 状态持久化：用户调整节点位置后，自动生成 patch 文件（可回写到导出的事件流），支持后续重现相同布局。


### 3. 数据流
- 事件日志导出：算法运行时生成 JSON/事件流。
- 插件解析：VS Code 插件读取事件流，驱动前端渲染。
- 双向交互：用户在前端操作节点，结果回写到事件流或代码。

### 4. 数据协议层
- 需要定义一个统一的数据协议，确保算法代码与前端渲染之间的通信顺畅。可以设计成一个简单的 JSON 格式，包含节点和边的属性、事件类型、时间戳等信息。
- 前后端解耦，未来可以为其他语言的算法提供类似的接口，支持其他开发环境的可视化需求。


---
## 📅 开发阶段规划
### 1. MVP
    - 事件流导出（JSON）
    - VS Code WebView 基础渲染（静态图）
    - 节点/边属性展示
### 2. 增强版
    - 动态事件回放（push/pop、剪枝）
    - GPU 加速布局
    - 节点合并与智能放缩
    - 条件样式映射与交互优化

---
## ✅ 当前实现进度（MVP 启动）

当前仓库已经落地第一批可运行代码：
- VS Code 插件命令：`GraphDyVis: Show Visualization`
- WebView + D3 静态图渲染
- 基础交互：搜索聚焦、缩放/平移、节点/边属性面板
- 动态事件回放：Play/Pause/Step/Reset
- 事件原因日志展示（reason）
- 协议与消息的运行时校验（非法消息安全忽略）

关键文件：
- 插件入口：`src/extension.ts`
- 消息契约：`src/protocol/contracts.ts`
- 事件协议与校验：`src/protocol/events.ts`
- WebView 前端：`webview/main.ts`
- 样式：`media/webview.css`
- 示例事件流：`data/sample-events.json`

---
## 🚀 本地运行（Extension + WebView）

前置：Node.js 18+，VS Code。

1. 安装依赖
```bash
npm install
```

2. 构建扩展与 WebView
```bash
npm run build
```

3. 校验 TypeScript
```bash
npm run check
```

4. 在 VS Code 中按 `F5` 启动 Extension Development Host

5. 在新窗口命令面板执行：
```text
GraphDyVis: Show Visualization
```

开发时可分别监听：
```bash
npm run watch:extension
npm run watch:webview
```

---
## 🧾 MVP 事件数据协议（schemaVersion = "1.0"）

示例文件：`data/sample-events.json`

顶层结构：
```json
{
    "schemaVersion": "1.0",
    "graph": {
        "nodes": [...],
        "edges": [...]
    },
    "events": [...]
}
```

### 节点（NodeRecord）
- 必填：`id` (string), `label` (string), `x` (number), `y` (number)
- 选填：`properties` (object, value 仅支持 string/number/boolean/null)

### 边（EdgeRecord）
- 必填：`id` (string), `source` (string), `target` (string)
- 选填：`label` (string), `weight` (number), `properties` (object)

### 事件（GraphEvent）

统一字段：
- 必填：`eventType`, `timestampMs`
- 选填：`reason`

事件类型：
1. `node_create`
- 必填：`node` (NodeRecord)

2. `edge_create`
- 必填：`edge` (EdgeRecord)

3. `edge_update`
- 必填：`id` (string)
- 选填：`newWeight` (number), `newProperties` (object)

4. `edge_delete`
- 必填：`id` (string)

兼容策略（MVP）：
- 顶层版本：`schemaVersion`
- 新字段优先采用可选追加（additive）
- 未识别字段或事件类型由消费端安全忽略，不导致崩溃

---
## 🔁 WebView 消息契约（contractVersion = "1.0"）

扩展 -> WebView：
1. `init-data`
- payload: 完整图数据与事件流（GraphDataFile）

2. `playback-state`
- payload: `{ status, eventIndex, totalEvents }`

3. `error`
- payload: `{ message }`

WebView -> 扩展：
1. `ready`
- 含义：WebView 已加载，可接收初始化数据

2. `focus-request`
- payload: `{ targetId }`

3. `playback-control`
- payload: `{ action }`
- action: `play | pause | step | reset`

回放语义（MVP 当前实现）：
- 扩展侧（Host）是播放状态与进度的唯一权威，维护 `{ status, eventIndex, totalEvents }`。
- WebView 侧按钮只发送 `playback-control` 请求，不在本地启动独立定时器。
- WebView 收到 `playback-state` 后按 `eventIndex` 同步渲染当前图状态（必要时 reset 后重放），避免双状态漂移。
- `play` 到达事件流末尾会自动切回 `paused`；`step` 每次最多推进 1 个事件；`reset` 回到初始图并清零进度。

契约约束：
- 每条消息均包含 `type`。
- Host 消息包含 `contractVersion = "1.0"`。
- 对不合法消息进行校验并安全拒绝。