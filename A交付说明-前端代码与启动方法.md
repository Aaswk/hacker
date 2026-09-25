# A → B 交付说明：前端代码与启动方法

> 交付方：A（前端 / 桌宠 / 摄像头）
> 接收方：B（后端 / 观察记录服务）
> 目的：让 B 能在本机跑起 A 的前端，并确认 A 是否正确轮询 B 的 `/observations`、是否按 B 实际的 `/species-card.summary` 显示。

---

## 1. 代码位置

```
hacker/frontend/            ← A 的前端工程（Next.js，独立于 B 的 app.py）
```

关键文件（B 只需关注消费接口的部分）：

| 文件 | 作用 |
| --- | --- |
| `frontend/lib/api.ts` | 所有对 B 的请求封装；`API_BASE_URL` 默认 `http://localhost:8001` |
| `frontend/hooks/useObservationFeed.ts` | 轮询 B 的 `GET /observations`，增量识别新记录 |
| `frontend/hooks/usePetState.ts` | Step 5 状态映射层：`Observation` → 动作 / 气泡 / 日志 |
| `frontend/app/live/page.tsx` | 联调入口页（本说明第 4 节用它验收） |
| `frontend/scripts/b-stub-server.mjs` | B 未启动时代的 Node 桩服务（见第 6 节） |

---

## 2. 启动方法

```powershell
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
npm install
npm run dev
```

- 前端监听：**http://localhost:3000**（端口与 A 文档约定一致）
- 打开联调页：**http://localhost:3000/live**

> B 需同时启动自己的 FastAPI（端口 **8001**）：
> `uvicorn app:app --port 8001`（按 B 自己的启动方式为准）

---

## 3. 地址与接口约定

A 端**全部走环境变量**，默认值已对齐团队端口：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8001` | B 的服务地址 |
| `NEXT_PUBLIC_VISION_BASE_URL` | `http://localhost:8002` | C 的服务地址 |

需要覆盖时，在 `frontend/.env.local` 写：

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8001
NEXT_PUBLIC_VISION_BASE_URL=http://localhost:8002
```

### A 消费的三个 B 接口（字段一律 snake_case，未做任何改名）

1. **`GET /observations`** → `list[Observation]`
   - A 取 `observation_id` 去重，按 `observation_id` **升序**补播（兼容 B 的 `ORDER BY id DESC` 返回顺序，A 不依赖数组顺序）
   - 气泡文案**只读 `message`**，不读其他候选字段

2. **`GET /species-card`** → `{ subject_id, event_counts, summary }`
   - A 只读 **`summary`** 显示在「RESEARCHER NOTE」区域
   - `event_counts` 留待 Step 7 做星级，本步骤不使用

3. **`POST /events`** → `201 { observation_id, event, pet_state, message }`
   - `/live` 页的「POST /events 造一条（联调）」按钮使用
   - 成功后 A 直接用返回体喂状态映射层，与轮询链路汇合

### CORS

B 的 `app.py` 已放行 `http://localhost:3000` / `http://127.0.0.1:3000`，A 端零配置可用。

---

## 4. B 侧验收步骤（3 分钟）

1. 启动 B 的 FastAPI（8001）+ A 的前端（3000）。
2. 打开 **http://localhost:3000/live**。
3. 点「**开始观察（轮询 B）**」。
4. 观察页面三处是否联动：
   - 顶部状态串：`pet_state = "..." · <中文> · 气泡队列 N 条 …· 已处理到 id M`
   - 观察舱：桌宠切换对应动作 + 弹出气泡（内容为 B 的 `message` 原文）
   - 右侧「HUMAN OBSERVATION LOG」：新增一条 `#id EVENT · PET_STATE` + `message`
5. 用下拉框选一个事件 → 点「POST /events 造一条（联调）」，确认三处同时更新。
6. 在 B 侧用任意方式造一条新记录，确认 A 下一次轮询（≤2s）自动补播。
7. 看「RESEARCHER NOTE」区域显示的是否为 B `/species-card` 的 `summary` 原文。

### 实测已通过项

| 检查项 | 结果 |
| --- | --- |
| 轮询地址 | `GET http://localhost:8001/observations`（每 2s） |
| 物种卡 | 显示 B 的 `summary` 原文：`已记录 14 次观察。该生物持续表现出值得研究的日常行为。` |
| 动作 | `PERSON_LEFT` → `ALERT`；`DRINKING` → `CURIOUS` |
| 气泡 | B 的 `message` 原文 + 按 `pet_state` 映射的语气芯片 |
| 日志 | `#15 PERSON_LEFT · ALERT`、`#16 DRINKING · CURIOUS`，id 升序去重 |
| 优先级 | `ALERT` 插队首，不被已在播的 `ALERT` 打断 |
| 状态回落 | 队列排空后回落 `OBSERVING` / 待机小剧场 |

---

## 5. A 对 Observation 的处理规则（供 B 对照）

- 契约 7 种 `pet_state`：`IDLE / OBSERVING / THINKING / CURIOUS / CONFUSED / ALERT / EXCITED`
- 6 种 `event`：`PERSON_ENTER / DRINKING / STRETCHING / PERSON_LEFT / PERSON_RETURNED / UNKNOWN`
- 同一个 `observation_id` **只消费一次**（轮询 + POST 直连两条链路都汇到同一入口，靠 id 去重）
- 气泡语气映射：`ALERT` → 警戒配色；`EXCITED` → 新发现配色；其余 → 观察记录配色
- 队列规则：B 的真实观察（`observation`）**永不因队列满被丢弃**，会挤掉一条本机待机闲聊；本机闲聊（`ambient`）队列满时直接丢弃

---

## 6. 关于本机无 Python：Node 桩服务

A 的实测环境没有 Python，无法启动 B 的 FastAPI，因此 A 用 Node 桩逐字段复刻了 `app.py` 的响应形状来联调：

```powershell
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
node scripts/b-stub-server.mjs      # 监听 http://localhost:8001
```

- 复刻端点：`GET /health`、`POST /events`（201）、`GET /observations`（id 倒序）、`GET /subjects/HUMAN_001`、`GET /species-card`（`summary` 文案与 `app.py` 一致）
- CORS 同样放行 3000
- **B 的真服务起来后，停掉这个桩、直接用真服务即可，前端无需改任何代码**

---

## 7. 待 B 确认的点

1. `GET /observations` 是否会持续增长、有无分页/上限（A 目前拉全量、客户端增量识别；数据量大时需加 `?since_id=` 之类的增量参数）。
2. `/species-card.summary` 的生成规则是否稳定（含空串场景：A 目前显示「—」占位）。
3. 是否新增事件类型 / pet_state（A 的枚举表在 `frontend/types/contract.ts`，新增需同步）。
