# Recipe Replay Service

工业机器人产线配方补丁重放网关。对一组**有序 RFC 6902 修订**在约定快照上进行重放，
基于 **RFC 8785 (JCS)** 的规范化 SHA-256 逐修订校验前置/后置摘要，保证控制站得到的
配置在任何机器上、任何时间重放都**字节唯一、可证明**。

- 零第三方运行时依赖（仅 Node.js ≥ 20 内置模块）。
- 严格 JSON 解析：拒绝重复键、非法 UTF-8、BOM；对象使用 null 原型，杜绝原型链污染。
- 严格 RFC 6901 指针：`~0` / `~1` 转义、数组索引（禁前导零 / `-` / 越界）、根路径。
- 完整 RFC 6902 六操作：`add` / `remove` / `replace` / `move` / `copy` / `test`。
- 每个修订在深拷贝上执行，任一操作失败整体回滚（修订级原子性）。
- 摘要不符、路径错误、`test` 失败一律 `422`，含修订序号、`revisionId`、操作序号与稳定错误码，且**立即终止**不继续后续修订。
- 请求正文上限 2 MiB；修订 1–64 个；每修订 1–100 个操作；`revisionId` 全请求唯一。

## API

### `POST /api/recipes/replay`

```json
{
  "baseline": { "motors": [{ "id": "m1", "speed": 10 }], "seq": [0, 1, 2] },
  "revisions": [
    {
      "revisionId": "rev-1",
      "beforeHash": "<64 lowercase hex sha256 of the JCS canonical bytes of the pre-image>",
      "afterHash":  "<...post-image...>",
      "operations": [
        { "op": "move", "from": "/seq/2", "path": "/seq/0" },
        { "op": "test", "path": "/motors/0/id", "value": "m1" },
        { "op": "add",  "path": "/escaped/a~1b~0c", "value": "weird" }
      ]
    }
  ]
}
```

成功 `200`：

```json
{
  "revisions": [{ "revisionId": "rev-1", "beforeHash": "…", "afterHash": "…" }],
  "finalDocument": { },
  "finalHash": "…"
}
```

失败（`4xx`）：

```json
{ "error": { "code": "TEST_FAILED", "message": "…",
  "location": { "revisionIndex": 0, "revisionId": "rev-1", "operationIndex": 1 } } }
```

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `REQ_MALFORMED` | 非法 JSON / 重复键 / 结构不符 |
| 400 | `REQ_OUT_OF_RANGE` | 修订数或操作数越界 |
| 413 | `REQ_TOO_LARGE` | 正文超过 2 MiB |
| 422 | `HASH_FORMAT` | 摘要非 64 位小写十六进制 |
| 422 | `HASH_BEFORE_MISMATCH` | 前置摘要与实际快照不符 |
| 422 | `HASH_AFTER_MISMATCH` | 后置摘要与补丁结果不符 |
| 422 | `REVISION_ID_DUPLICATE` | `revisionId` 不唯一 |
| 422 | `PATH_SYNTAX` | 指针/`from` 语法错误（如 `a~2b`、缺少 `/`） |
| 422 | `PATH_NOT_FOUND` / `INDEX_OUT_OF_RANGE` | 目标不存在或数组越界 |
| 422 | `TEST_FAILED` | `test` 操作深度比较失败 |
| 422 | `MOVE_TARGET_ILLEGAL` | `move` 到自身后代 |
| 422 | `OP_INVALID` | 未知操作或缺字段 |

### `GET /healthz`

`200 {"status":"ok"}`，供 Docker / Compose 健康检查使用。

## 本地运行（无需 Docker）

```bash
npm test               # 35 个单元测试（JCS/指针/补丁/重放）
node build.js          # 语法 + 模块加载“构建”检查
npm run smoke          # 临时起服务跑 HTTP 冒烟（转义指针/数组移动/失败原子性/413…）
python3 test/jcs_crosscheck.py .   # 独立 Python JCS 预言机随机交叉验证（可选）
PORT=8080 npm start
```

## Docker / Compose

```bash
# 构建并启动 API（宿主机端口可配置）
APP_PORT=9090 docker compose up -d --build api
curl -s http://localhost:9090/healthz

# 一次性校验服务：等待 api 健康后，依次执行
#   单元测试 → 应用构建 → 真实 HTTP 冒烟；退出码即结果
docker compose run --rm verify
```

`compose.yaml`：

- `api`：发布 `${APP_PORT:-8080}:8080`，带 `healthcheck`（轮询 `/healthz`）。
- `verify`：`restart: "no"` 的一次性任务，`depends_on: api: condition: service_healthy`，
  依赖就绪后运行 `node test/run-tests.js && node build.js && node test/smoke.js`
  （`BASE_URL=http://api:8080`），全部成功退出 0，否则非零。

## 实现说明（关键正确性点）

- **JCS 数值**：以 `Number.prototype.toString` 的最短往返十进制为基准，按
  RFC 8785 §3.2.2.2 边界（指数 `< -6` 或 `>= 21`）切换定点 / 科学表示；
  科学表示尾数强制含小数点（`1e21 → 1.0E+21`，`1e-7 → 1.0E-7`）；`-0 → 0`。
  已经与独立 Python 实现在 300+ 随机文档上逐字节对齐。
- **键序**：按 UTF-8 字节序（非 UTF-16 码元序）排序，组合字符等情形与标准一致。
- **数组位移**：`add` 用 `splice` 插入、`-` 追加；`move` 先取深拷贝值、再删除、再插入，
  严格遵循 RFC 6902（如 `/a/1 → /a/2` 对 `[1,2,3]` 得 `[1,3,2]`）。
- **指针转义**：仅承认 `~0 → ~`、`~1 → /`，且解码顺序固定（先 `~` 后数字），
  独立的 `/` 分隔不会误吞；键名 `a/b~c` 写作 `/a~1b~0c`。
- **原子性**：修订开始即对当前文档深拷贝（保留 null 原型），失败时直接丢弃拷贝，
  已执行操作不留痕迹；随后的前置摘要链因此不会被污染。
- **原型安全**：解析对象全部为 `Object.create(null)`，补丁写入 `__proto__` /
  `constructor` 只是普通数据成员，绝不触碰原型链。
