# PXD - Stable Diffusion Forge UI 桥接插件

PXD 是一个用于 Photoshop 的 UXP 插件，提供与 Stable Diffusion Forge UI 的桥接功能。通过该插件，您可以直接在 Photoshop 中调用 SD WebUI API 进行 AI 图像生成，无需切换应用即可实现文生图、图生图等功能。

## 主要功能

- **Stable Diffusion 集成**：直接连接本地或远程 SD Forge UI / WebUI API
- **文生图（Text-to-Image）**：通过提示词生成图像
- **图生图（Image-to-Image）**：基于现有图层进行 AI 改造
- **ControlNet 支持**：使用 ControlNet 模型进行精确控制
- **模型管理**：动态加载 Checkpoint、VAE、LoRA、采样器等配置
- **实时预览**：支持生成进度监控和预览
- **Photoshop 集成**：自动导入生成结果为新图层
- **智能超时**：根据分辨率和步数自动计算请求超时时间
- **预设管理**：支持参数预设的保存、加载和导出
- **文件夹快捷访问**：一键打开数据目录和预设目录

## 技术架构

- **前端框架**：React 18 + TypeScript
- **构建工具**：Vite 5
- **UXP API**：封装 Photoshop 文件系统、剪贴板等原生能力
- **API 客户端**：完整的 SD WebUI API 封装

## 目录结构

```
PXD/
├── src/
│   ├── services/
│   │   ├── apiClient.ts      # SD WebUI API 客户端
│   │   ├── photoshop.ts      # Photoshop 操作封装
│   │   ├── uxpBridge.ts      # UXP 桥接层
│   │   └── settings.ts       # 配置管理
│   ├── panels/               # UI 面板组件
│   ├── context/              # React Context 状态管理
│   └── hooks/                # 自定义 Hooks
├── public/                   # 静态资源
├── manifest.json             # UXP 插件清单
├── vite.config.ts            # Vite 配置
└── package.json              # 项目依赖
```

## 快速开始

### 环境要求

- Node.js 16+
- Photoshop 2023 (v24.0.0) 或更高版本
- Stable Diffusion Forge UI / WebUI (已启动并开启 API)

### 安装依赖

```bash
npm install
```

### 开发调试

**方式一：浏览器预览（快速 UI 调试）**

```bash
npm run dev:browser
```

在浏览器中打开 `http://localhost:5173` 进行界面开发。

**方式二：Photoshop 联机调试**

需要同时运行两个终端：

```bash
# 终端 1：实时构建
npm run watch

# 终端 2：加载到 Photoshop
npm run dev
```

这会通过 UXP Developer Tool 将插件加载到 Photoshop 中。

### 构建插件

```bash
npm run build:plugin
```

构建完成后，`dist/` 目录包含完整的插件文件。

## 打包与分发

1. 运行 `npm run build:plugin` 生成 `dist/` 目录
2. 打开 **Adobe UXP Developer Tool**
3. 选择 `dist/` 目录进行加载或打包为 `.ccx` 文件
4. 将 `.ccx` 文件分发给用户安装
5. 也可以直接将 `dist/` 文件夹放入Photoshop的 `plug-in/` 文件夹中

## 使用说明

### 配置 SD API 地址

1. 在 Photoshop 中打开插件面板（窗口 > 扩展 > PXD 控制台）
2. 进入设置面板
3. 输入 SD Forge UI 地址（默认：`http://127.0.0.1:7860`）
4. 测试连接确认可用

### 超时设置

插件支持智能超时机制，根据图像分辨率和生成步数自动计算合适的超时时间：

- **超时倍率**：全局超时时间的调整系数（默认 1.0）
- **最短超时**：最小超时时间限制（默认 20 秒）
- **最长超时**：最大超时时间限制（默认 120 秒）

计算公式会考虑分辨率（相对于 512x512）和步数，自动在最短和最长超时之间调整。

### 文生图流程

1. 输入提示词（Prompt）
2. 选择模型、采样器等参数
3. 点击生成
4. 生成完成后自动导入为新图层

### 图生图流程

1. 在 Photoshop 中选择图层
2. 插件会自动读取当前图层
3. 调整重绘强度（Denoising Strength）
4. 点击生成

## API 支持

插件支持以下 SD WebUI API 端点：

- `/sdapi/v1/txt2img` - 文生图
- `/sdapi/v1/img2img` - 图生图
- `/sdapi/v1/sd-models` - 获取模型列表
- `/sdapi/v1/sd-vae` - 获取 VAE 列表
- `/sdapi/v1/loras` - 获取 LoRA 列表
- `/sdapi/v1/samplers` - 获取采样器列表
- `/sdapi/v1/schedulers` - 获取调度器列表
- `/sdapi/v1/progress` - 生成进度查询
- `/controlnet/model_list` - ControlNet 模型列表
- `/controlnet/module_list` - ControlNet 预处理器列表

## 开发说明

### 添加新功能

- API 相关逻辑：编辑 `src/services/apiClient.ts`
- Photoshop 交互：编辑 `src/services/photoshop.ts`
- UI 组件：添加到 `src/panels/` 或 `src/components/`

### 权限配置

插件需要以下权限（已在 `manifest.json` 中配置）：

- `localFileSystem`: 读写临时文件和配置
- `network`: 调用 SD API
- `clipboard`: 剪贴板访问
- `allowCodeGenerationFromStrings`: 动态脚本执行

## 路线图

### 已完成

- ~~[x] **修复弹窗图层问题**：解决插件与 Photoshop 图层交互时的弹窗异常~~
- ~~[x] **智能超时机制**：实现基于分辨率和步数的动态超时计算~~
- ~~[x] **文件夹管理**：添加快捷打开数据目录和预设目录功能~~
- ~~[x] **预设导出**：支持预设文件的导出和管理~~

### 高优先级

- [ ] **修复分辨率问题**：解决分辨率 2048 下返回错误和自定义分辨率无法设置的问题

### 中优先级

- [ ] **定制化 UI**：支持自定义面板主题和布局配置
- [ ] **支持云部署**：兼容远程 SD 服务器，支持团队协作场景
- [ ] **支持 ComfyUI**：扩展 ComfyUI 工作流 API 集成，提供更灵活的节点控制

### 低优先级

- [ ] **多语言翻译**：添加英文、日文等多语言界面支持

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request。
