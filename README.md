# Recipe Replay Service

工业机器人产线按版本下发 JSON 配方补丁。本服务对一个 **基线 JSON 对象**
顺序重放一至多个 **RFC 6902** 修订，并在每个修订前后用 **RFC 8785 (JCS)**
规范化字节的 SHA-256 摘要校验“约定快照”，确保不同控制站对同一批补丁得到
**唯一、确定**的结果，杜绝数组位移、指针转义歧义或数值表示差异。

- 运行时零第三方依赖，仅使用 Node.js（≥ 22）内置模块。
- 每个修订 **原子生效**：任一操作失败则整个修订回滚，且不再继续后续修订。
- 失败返回 `422`，指出修订下标、修订 ID 与（适用时）操作下标及稳定错误码。

## 接口

### `GET /health`

存活探针，返回 `200 {"status":"ok"}`。

### `POST /api/recipes/replay`

请求头建议 `Content-Type: application/json`，整体正文 **不超过 2 MiB**。

```json
{
  "baseline": { "robot": "arm-01", "points": [0, 0] },
  "revisions": [
    {
      "revisionId": "rev-2026-10-07-01",
      "preHash": "<64 位小写十六进制 SHA-256>",
      "postHash": "<64 位小写十六进制 SHA-256>",
      "operations": [
        { "op": "add", "path": "/points/-", "value": 42 }
      ]
    }
  ]
}
```

约束：

| 项 | 约束 |
| --- | --- |
| `baseline` | JSON 对象 |
| `revisions` | 1–64 个，按数组顺序执行 |
| `revisionId` | 非空字符串，且在本请求内唯一 |
| `preHash` / `postHash` | 64 位**小写**十六进制 SHA-256 |
| `operations` | 每个修订 1–100 个 RFC 6902 操作 |

摘要算法：对文档做 RFC 8785 规范化，再对其 **UTF-8 字节**计算 SHA-256。
规范化要点：对象成员按属性名 **UTF-16 码元**升序递归排序、数组顺序不变、
数字采用 ECMAScript `Number::toString`（短十进制优先，含 `1e+30`/`1e-27`
等表示）、字符串按规定转义、拒绝孤星代理与非有限数。

支持全部六类操作（`add` / `remove` / `replace` / `move` / `copy` / `test`），
JSON Pointer 严格处理根路径（`""`）、`~0`/`~1`（先解 `~1` 再解 `~0`）、
非法转义（如 `~2`、悬空 `~`）、数组索引（禁止前导零、`-` 仅表示末尾之后）。

#### 成功响应 `200`

```json
{
  "status": "ok",
  "revisions": [
    { "revisionId": "rev-2026-10-07-01", "postHash": "…" }
  ],
  "finalDocument": { "robot": "arm-01", "points": [0, 0, 42] },
  "finalHash": "…"
}
```

`finalHash` 等于最后一个修订的 `postHash`，即最终文档的 RFC 8785 摘要。

#### 失败响应 `422`

任一 **前置摘要不符、指针解析失败、`test` 断言失败、补丁语义错误、
后置摘要不符** 时返回，且不再执行后续修订：

```json
{
  "error": {
    "code": "TEST_ASSERTION_FAILED",
    "message": "Test operation failed: …",
    "revisionIndex": 1,
    "revisionId": "rev-b",
    "operationIndex": 1
  }
}
```

`revisionIndex` / `operationIndex` 均为 **0 基**；纯摘要类失败不对应具体
操作，`operationIndex` 为 `null`。

稳定错误码：

| code | 触发条件 |
| --- | --- |
| `PRE_HASH_MISMATCH` | 修订前置摘要与当前重放快照不符 |
| `POST_HASH_MISMATCH` | 修订应用结果的摘要与声明的后置摘要不符 |
| `INVALID_POINTER_SYNTAX` | 指针缺少起始 `/`、非法 `~` 转义、数组索引含前导零等 |
| `POINTER_TARGET_NOT_FOUND` | 对象成员/数组元素不存在；`-` 被用于取具体值 |
| `POINTER_TRAVERSAL_FAILURE` | 试图穿越非容器（标量）继续寻址 |
| `ARRAY_INDEX_OUT_OF_RANGE` | `add` 的数组下标大于当前长度 |
| `MOVE_INTO_DESCENDANT` | `move` 的 `from` 是 `path` 的真前缀 |
| `TEST_ASSERTION_FAILED` | `test` 操作的值与目标不一致（含类型不同） |
| `UNKNOWN_OPERATION` | `op` 不在六类之内 |
| `INVALID_OPERATION` / `MISSING_PATH` / `MISSING_VALUE` / `MISSING_FROM` | 操作结构非法或缺字段 |
| `ROOT_CANNOT_BE_REMOVED` | `remove` 指向文档根 |

结构性/传输类错误：`400`（请求结构、非法 JSON、重复键、孤星代理、
数值越界、嵌套过深等）、`413`（正文超过 2 MiB）、`404`（未知路由）。

## 本地运行（无需安装依赖）

```bash
npm start                 # 默认 0.0.0.0:8080
PORT=9090 npm start       # 自定义端口
```

健康检查：

```bash
curl -s http://127.0.0.1:8080/health
```

## 测试、构建与验证

```bash
npm test     # 170 个单元测试（RFC 6902 附录用例、RFC 8785 附录 B 数字、
             #  严格解析、61 个独立生成的重放向量等）
npm run build  # 语法/加载校验并产出带 SHA-256 清单的 dist/
npm run smoke  # 启动真实 HTTP 服务执行 361 项端到端冒烟
npm run verify # 依次执行上面三步；以退出码报告结果（0 = 全部通过）
```

端到端向量（`test/fixtures/*.json`）由**独立实现**在仓库外生成：
摘要用 Python 的 RFC 8785 参考实现 `jcs`，补丁结果用独立的 `jsonpatch`，
数字序列化另以 30 万+ 随机 IEEE 754 双精度与 Node 输出做差分验证。
重新生成（需要 Python 3.11 与这两个包，仅为离线开发用途，运行时不需要）：

```bash
python -m venv .venv && . .venv/bin/activate
pip install jcs jsonpatch pyyaml
python scripts/gen_jcs_vectors.py
python scripts/gen_fixtures.py
```

## Docker 与 Compose

```bash
docker compose up -d --build api      # 启动 API（带健康检查）
HOST_PORT=9090 docker compose up -d --build api   # 自定义宿主机端口
docker compose up --build verify      # 一次性验证服务
docker compose ps                     # 查看 verify 的退出码
```

- `api`：宿主端口由 `HOST_PORT`（默认 `8080`）配置，容器内固定 8080；
  配置了 Docker 与 Compose 两层健康检查。
- `verify`：`depends_on: api: condition: service_healthy`，依赖就绪后依次
  运行单元测试、应用构建和 HTTP 冒烟（含转义指针、数组移动、失败原子性），
  完成即退出；其容器退出码即总体结论。

## 目录结构

```
src/
  jcs.js        RFC 8785 规范化
  jsonparse.js  严格 JSON 解析（拒绝重复键/孤星代理/非有限数，限深 1000）
  pointer.js    RFC 6901 JSON Pointer
  patch.js      RFC 6902 六类操作 + 修订级原子性
  replay.js     修订链重放与前置/后置摘要校验
  server.js     node:http 服务（/health 与 /api/recipes/replay）
test/           单元测试、HTTP 冒烟与独立生成的夹具
scripts/        构建、健康检查与夹具生成脚本
Dockerfile, compose.yaml
```
