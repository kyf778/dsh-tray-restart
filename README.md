# DSH tray restart — 托盘一键重启

给 DeepSeek Harness 桌面版（Windows）的系统托盘右键菜单加上一个 **重启**。

原本托盘里只有两项，要重启只能「退出」再手动打开：

```
打开 DeepSeek Harness
────────────
退出 DeepSeek Harness
```

装完之后变成三项，重启就夹在打开和退出之间：

```
打开 DeepSeek Harness
重启 DeepSeek Harness
────────────
退出 DeepSeek Harness
```

用词、分组、分隔线都跟应用自身其他菜单保持一致（「重启」这项复用了应用自身的重启路径，不是另起一套）。

## 为什么不是一个普通插件

DSH 的插件系统（`cordis.patch.yml`）只能组合**后端服务**，而托盘图标是 Electron **主进程**里的 `DesktopTray` 类创建的，插件 API 够不到它。所以这里只能直接改主进程文件。

具体改的是 `resources/app.asar` 里的 `lib/main.js`，一共四处改动：

| 位置 | 改动 |
| --- | --- |
| 中文词典 | 新增 `restartTrayApplication: "重启 DeepSeek Harness"` |
| 英文词典 | 新增 `restartTrayApplication: "Restart DeepSeek Harness"` |
| 托盘构造 | 注册 `restart` 动作 |
| 托盘菜单 | 在「打开」和「退出」之间插入菜单项 |

新词典键是**单独加的**，没有复用已有的 `restartApplication`（那是崩溃恢复对话框的按钮文案），避免顺带改掉别的界面的文字。

## 安装

需要 Node.js 18+。先**完全退出** DeepSeek Harness（托盘右键 → 退出），否则文件被占用写不进去。

安装分两种情况。

**Windows 上推荐用安装脚本**——它会自动处理「应用正在运行导致文件被锁」的问题：

```bat
git clone https://github.com/kyf778/dsh-tray-restart.git
cd dsh-tray-restart
install.cmd
```

脚本发现 Harness 在运行时会先问你要不要关掉它，打完补丁再问要不要帮你重新打开。

**或者直接用 Node 命令**（需自行先完全退出 Harness）：

```bash
node index.js apply
```

> Windows 在 Harness 运行时**锁住** `resources/app.asar`，所以必须先退出应用（托盘右键 → 退出）再打补丁，否则写不进去。脚本会检测并提示这一点。

看到 `Patched lib/main.js` 后重新打开 DeepSeek Harness，右键托盘图标即可看到「重启 DeepSeek Harness」。

如果应用装在非默认位置：

```bat
install.cmd -Asar "D:\path\to\app.asar"
node index.js apply --asar "D:\path\to\app.asar"   # 或设环境变量 DSH_ASAR
```

支持的命令：

| 命令 | 作用 |
| --- | --- |
| `install.cmd` | 一键安装（自动关闭/重开 Harness） |
| `uninstall.cmd` | 一键还原 |
| `node index.js status` | 查看是否已打补丁 |
| `node index.js apply` | 打补丁（先自动备份，可重复执行） |
| `node index.js restore` | 从备份还原成原版 |
| `node index.js verify` | 重新校验 asar 内每个文件的完整性 |

> 如果 PowerShell 提示脚本未签名，那是 Windows 的默认执行策略所致；`install.cmd` / `uninstall.cmd` 已经带上了 `-ExecutionPolicy Bypass`，用它们就不会遇到这个问题。

## 安全性

改的是应用安装目录里的二进制包，所以做了这些防护：

- **先备份再动手**。第一次 `apply` 会把原 `app.asar` 存成 `app.asar.dsh-tray-restart.bak`，`restore` 能一键还原成逐字节一致的原文。
- **只改一个文件**。重写时其余 11469 个文件原样复制，只替换 `lib/main.js`；测试里逐文件比对哈希来验证这一点。
- **锚点必须唯一**。四处改动的匹配串各自只允许出现一次，任何一处对不上就立刻中止、**不写盘**。DSH 升级后如果这段代码变了，脚本会拒绝执行而不是把文件改坏。
- **重算完整性**。asar 里每个文件都带 `integrity` 记录，脚本改完之后会重新计算。
- **幂等**。已打过补丁会直接提示，不会重复插入。

验证过的环境：Windows 11 + DeepSeek Harness Desktop **0.2.0-rc.2**（应用版本 44.0.0，`dshBuildCommit` `04f392c`）。

## 升级 DeepSeek Harness 之后

应用升级会覆盖 `resources/app.asar`，补丁随之失效。**升级后重新跑一次 `node index.js apply` 即可。**

因为锚点机制的存在，如果新版本的 `lib/main.js` 结构变了，脚本会安全地中止并提示你，不会写坏文件——这时到仓库提个 issue 说明版本号即可。

## 测试

```bash
node test/run-tests.cjs
```

测试全在临时目录里对 `app.asar` 的**副本**进行，不会碰你装好的应用。覆盖 31 项检查：头部字节往返、补丁前后逐文件哈希比对、完整性、语法、托盘菜单行为（含「关闭中点击不响应」的竞态防护）、幂等、还原逐字节一致、以及锚点失配时的安全中止。

找不到 `app.asar` 时会输出 SKIP 而不是失败。

## 卸载

```bat
uninstall.cmd
```

或先退出 Harness，再手动还原：

```bash
node index.js restore
```

然后删掉仓库目录即可。

## 兼容性

- 只在 **Windows** 上有效。托盘的 `DesktopTray` 类本身就是在 `process.platform === "win32"` 分支里构造的，macOS / Linux 没有这个菜单。
- 只在桌面版（Electron）上有效，`dsh web` 没有托盘。

## 作者的话

每次想重启都得先退出、再满桌面找图标点开，实在烦。既然官方菜单里「重启」的文案和逻辑都是现成的，那不如直接把它挪到托盘里。

祝你用得顺手，顺手的话右上角点个 Star。

## License

MIT
