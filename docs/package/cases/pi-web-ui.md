# pi-web-ui

## install

直接用不好用, 需要手动加入行内 `$` 考虑情况.

### 克隆项目

```bash
mkdir -p ~/.pi/custom
cd ~/.pi/custom

git clone https://github.com/kkkiio/pi-web-ui.git
cd pi-web-ui
npm install
npm run build:web
```

### 修改文件

#### 修改一

路径: `custom/pi-web-ui/src/web/components/ai-elements/message.tsx`

把：

```tsx
import { math } from "@streamdown/math";
```

改成：

```tsx
import { createMathPlugin } from "@streamdown/math";
```

再把：

```tsx
const streamdownPlugins = { cjk, code, math, mermaid };
```

改成：

```tsx
const math = createMathPlugin({
  singleDollarTextMath: true,
});

const streamdownPlugins = { cjk, code, math, mermaid };
```

#### 修改二

路径: `~/.pi/custom/pi-web-ui/src/web/components/ai-elements/message.tsx`

在 import 区域加一行：

```tsx
import "katex/dist/katex.min.css";
```

例如：

```tsx
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";
```

### 编译

```tsx
cd ~/.pi/custom/pi-web-ui
npm install
npm run build:web
pi install "$HOME/.pi/custom/pi-web-ui"
```

用你的前端启动 Pi：

```tsx
export PI_WEB_UI_STATIC_DIR="$HOME/.pi/custom/pi-web-ui/dist"
pi
```

然后 /webui，测试 $E=mc^2$。

如果正常，再把这句写进 `~/.bashrc`：

```bash
export PI_WEB_UI_STATIC_DIR="$HOME/.pi/custom/pi-web-ui/dist"
```

## command

```bash
/webui
```
