# configuraton

## models

切换模型使用 `/models`

### provider

```bash
/login
```

无论从api key还是account登录都有provider, 足够使用. 可以使用环境变量.

### 默认值设置

#### 全局默认模型

完全交互式即可, 选中所用的model或者thinking, `C+s` 即可保存默认值

#### 模型特定配置

```bash
\settings Default thinking/model # 配置具体模型的默认thinking level
```

## 配置文件

```bash
~/.pi/agent/settings.json    # 全局
项目/.pi/settings.json       # 项目
```

不要去修改 `auth.json` 和删除 `models-store.json`(这只是一个缓存)

主要是修改 `settigns.json`
