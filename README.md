# dsh-window-memory

DeepSeek-Harness 插件：记住 DSH Desktop 主窗口的位置与尺寸，下次启动时还原。

关闭时处于最大化，则以**最大化之前**的尺寸打开——最大化是临时状态，不是用户选定的摆放。

## 特性

- 重开应用时，窗口回到关闭时的位置与尺寸；
- 关闭时最大化，则以最大化之前的尺寸打开；
- 每次启动只恢复一次（`sessionStorage` 标记），页面内刷新不会覆盖刚调好的大小；
- 尺寸不低于 DSH 原生窗口最小值（520×600）；
- 保存的位置在任何显示器都不可见时（例如拔掉副屏）拒绝恢复，避免窗口跑到屏幕外；
  部分越界则拉回最近的显示器，尺寸不变；
- 不写 Host 侧配置文件，全部状态在浏览器 `localStorage` 中。

## 运行环境

**仅 DSH Desktop。** 插件依赖一个真实存在、用户可拖动缩放的窗口；浏览器标签页没有这样的
窗口（视口属于浏览器本身），因此插件在那里整个不启动：不恢复、不记录、不注册监听、不写存储。

判断依据按可靠性排序，任一成立即认定是 Desktop：

| 信号 | 来源 | 说明 |
| --- | --- | --- |
| `location.protocol === 'dsh-app:'` 且 `hostname === 'app'` | 主窗口 URL | 最直接：该 scheme 只有 Desktop 注册 |
| `<html data-platform="…">` | Desktop preload | 官方客户端 bundle 同样读取该属性 |
| `__DSH_HOST_PATHS__` / `dshDesktopBoot` / `dshDesktop` | 同一个 preload | 兜底：preload 可能把标记推迟到 DOMContentLoaded |

三个信号都**不比较具体平台值**（不写死 `win32`），因此新增平台不会误判。

> **为什么不在 `package.json` 里声明？** 因为声明不了：DSH 的客户端加载器只接受
> `dsh.client.platform === "web"` 这一个值，其他值会让整个浏览器半边不被加载。
> 限制因此落在运行时。manifest 中的 `dsh.runtime.shell` 是给人看的说明，不是 DSH 执行的
> 开关——真正把关的是 `isDesktopShell()`。

## 工作原理

工作区文档就是主窗口的顶层文档，因此 `window.moveTo()` / `window.resizeTo()` 直接作用于
BrowserWindow。渲染进程读到的矩形与真实窗口矩形存在固定内缩差，所以放置是一段对**请求值**
的修正循环，而不是一次赋值。

设计细节、实测数据与已知限制见 [`docs/window-state.md`](docs/window-state.md)。

## 控制

插件**没有设置页、没有偏好开关**，唯一控制是「插件」页上本插件的启用开关：

| 状态 | 行为 |
| --- | --- |
| 启用（默认） | 记住窗口位置与尺寸，重开时还原 |
| 停用 | 浏览器半边不执行，既不恢复也不记录 |

停用意味着 `apply()` 不被调用，因此不存在「插件在运行但功能关闭」的中间状态。

## 安装

要求：**DSH Desktop**（本插件在浏览器里不生效），以及能访问插件来源的网络。

### 方式一：在「插件」页安装（推荐）

1. 打开 **设置 → 插件**；
2. 点右上角 **添加插件**；
3. 选 **安装第三方插件**（说明文字为「支持 npm 包、Git 仓库和本地目录」）；
4. 在「包名或地址」里填入下面任意一种，然后点 **安装**：

| 填法 | 值 |
| --- | --- |
| **npm 包名** | `dsh-window-memory` |
| Git 仓库地址 | `https://github.com/notpdpton/dsh-window-memory` |
| Git 简写 | `github:notpdpton/dsh-window-memory` |
| SSH | `git@github.com:notpdpton/dsh-window-memory.git` |
| 本地目录（绝对路径） | `D:/path/to/dsh-window` |

五种写法都能被识别（本地目录必须是绝对路径）。**优先用 npm 包名**：它最快，也不经过
Git 的连通性检查。Git 地址不需要带 `.git` 后缀，也不需要预先构建：本包是纯 JS，
没有 `prepare` 之类的构建步骤，克隆下来即可加载。

5. 装完按提示 **重启 DSH**；
6. 重启后回到「插件」页，`dsh-window` 的卡片出现在「已安装插件」下，开关默认打开。

> 「安装源」只对 npm 包名生效；Git 地址走单独的连通性检查，与安装源无关。
> 国内网络下如果 npm 官方源慢，可以改用镜像源（设为 `https://registry.npmmirror.com`）。

#### 如果安装卡住或报「无法连接插件源」

Git 安装前 DSH 会先跑一次连通性检查（`git ls-remote`），默认超时 **5 秒**（可通过
`githubConnectionTimeoutMs` 调整）。
若你的网络需要代理才能访问 GitHub，而代理没有覆盖到这一步，检查就会超时，
界面上表现为「无法连接插件源，请检查网络后重试」。

按顺序排查：

1. **让代理对 DSH 进程生效**。DSH 会把自身的代理设置传给这个子进程，
   所以先在 **设置 → 插件 → 不二布丁光子 → 网络代理** 里配置好，再重试；
2. 直接用命令行确认链路本身没问题：

   ```bash
   git -c credential.helper= ls-remote -- https://github.com/notpdpton/dsh-window-memory HEAD
   ```

   能在几秒内返回一行 sha 就说明链路可用；一直挂住则是网络问题，与本插件无关；
3. 仍然超时的话，改用**方式二**（profile 里声明 + 自己执行 `pnpm`），
   或者填入**本地目录**路径安装——两者都不经过这个连通性检查。

详情日志在 `<profile>/.plugin-manager/logs/github-connection-*/`。

### 方式二：在 profile 里声明（适合固定版本/离线环境）

把包加入 profile 的依赖与 bundle 列表：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-window-memory": "github:notpdpton/dsh-window-memory"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "dsh-window-memory"
      ]
    }
  }
}
```

本地开发时指向源码目录，改完刷新即可看到变化：

```bash
pnpm add link:D:/path/to/dsh-window --dir <profile>
```

`bundles` 里必须写上 `dsh-window-memory`：只加依赖不写 bundle，包会被装进来但不会被加载。
（走「方式一」时不需要手写——安装完成后 DSH 会自动把带 `dsh.bundle` 的包追加进
`bundles`，这一节是给手工改 profile 的人看的。）

### 验证是否生效

1. 「插件」页能看到 `dsh-window-memory` 卡片，标题为「窗口记忆」，开关为开；
2. 拖动窗口到任意位置、改个大小，然后**完整退出 DSH 再打开**；
3. 窗口应回到你离开时的位置与尺寸。

若第 3 步没有效果，先确认第 1 步的开关是开的——**停用时插件不会执行**，不会留下任何日志。
其次确认是 DSH Desktop 窗口而非浏览器标签页：插件在浏览器里按设计不启动。

### 卸载

在「插件」页的插件详情里点 **卸载**，或从 profile 的依赖与 `bundles` 中移除 `dsh-window-memory`。
插件不写 profile 目录下的任何配置文件；卸载后除浏览器 localStorage 中的
`dsh-window-memory:window-state` 之外没有残留。

## 发布

本包以 npm 发布，包名 `dsh-window-memory`（公开）。

```bash
npm pack --dry-run      # 预演：只列出将要发布的文件，不上传
git tag -s v0.1.0 -m "v0.1.0"   # 与提交一样用 GPG 签名标签
npm publish             # 需要已登录 npm，且账号拥有该包
git push --tags
```

- `package.json` 里**不能**有 `"private": true`，否则 npm 直接以 `EPRIVATE` 拒绝；
- `publishConfig.access = "public"` 已声明，避免误发成受限包；
- 版本号变化才允许发布：已发布的版本号不能被覆盖，只能发新版本或 `npm deprecate`；
- 发布的文件由 `files` 控制，共 10 个（`test/` 与 `.gitattributes` 不进包）。

## 存储

| 存储 | 键 | 内容 |
| --- | --- | --- |
| `localStorage` | `dsh-window-memory:window-state` | 窗口几何文档 `{ v, rect, dpr, maximized, frame, updatedAt }` |
| `sessionStorage` | `dsh-window-memory:window-restored` | 本次启动已处理过恢复的标记 |

两个键都由本插件独占，不与任何其他插件共享。

## 目录

```text
dsh-window-memory/
├── package.json        包清单：dsh.bundle.patch、dsh.client、导出表
├── cordis.patch.yml    插入本插件那一行（id 与包名一致）
├── index.js            Host 半边（刻意为空：纯渲染进程功能）
├── client.js           浏览器半边：放置策略、运行时绑定
├── icon.svg            「插件」页图标
├── locale/
│   ├── en.json         插件卡片文案
│   └── zh.json
├── docs/
│   └── window-state.md 设计文档：坐标陷阱、最大化、漂移与实测数据
└── test/
    ├── verify-plugin.mjs  清单审计：行、半边、身份、图标、自包含、无界面、文案长度
    ├── verify-window.mjs  行为校验：编解码、夹取、越界、修正循环、唯一控制、legacy、桌面限定
    └── verify-engines.mjs 引擎范围：下界必须低于当前运行的 DSH
```

## 测试

三个校验，全部离线，不需要启动 DSH：

```bash
node test/verify-plugin.mjs              # 清单审计 + 负向断言
node test/verify-window.mjs              # 行为校验
node test/verify-engines.mjs 0.2.1-rc.3  # 引擎范围能否被这版 DSH 接受
```

前两个跑 shim `window.__ModuleLoader__`，执行**真正发布的** `client.js`，不复制产品代码；
任何一条变红都意味着能装出来的东西坏了。

`verify-engines` 只管一件事：`dsh.engines.dsh` 的下界必须低于当前运行的 DSH 版本。
写高一个小版本，插件会安静地不被加载——没有报错，只是「装上了却没出现」。

## 许可

MIT
