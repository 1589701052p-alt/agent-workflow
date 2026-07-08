# RFC-147 · 系统通道端口描述符注册表（plan）

> 单 PR（域小、五消费面一次切换可控）。授权语境：G3-G10 批量授权，设计门后直接实现。

## 任务分解

### RFC-147-T1 注册表 + 语义格测试（先钉后收）

- 新建 `shared/systemChannelPorts.ts`：SYSTEM_CHANNEL_PORTS（satisfies）+ 四投影
  （isSystemChannelEdge / touchesSystemChannelPort / PROMPT_INJECTED_PORT_NAMES /
  channelEdgeDataflowSkip）；barrel 导出。
- `rfc147-system-channel-ports.test.ts`：表值锁 + dataflow 语义格（对**现行 scheduler
  手写语义**逐格对齐）+ 分侧/宽判格 + 派生集一致性。

### RFC-147-T2 六消费面切换 + 棘轮

- clarify.ts 薄别名；sync-diff / prompt 删私有集改投影；scheduler / dispatchFrontier
  改 channelEdgeDataflowSkip（删手抄）；taskQuestionDispatch 改 isClarifyChannelEdge。
- grep 棘轮入 T1 测试文件（私有拷贝标识符零再现 + 共享判定引用锚）。
- 回归：cross-clarify rfc056 群 / sync-diff / prompt / validator / canvas 级联全绿。

**commit（单）**：`feat(scheduler): RFC-147 系统通道端口注册表——6 处 3 语义家族收敛`

## 门禁节奏

typecheck×3 + lint + format + 定向套件（rfc147 新测 + rfc056 群 + sync-diff + prompt +
validator + frontier）+ 后端全量 + binary smoke（shared 导出面变更）→ push → CI
conclusion 直查 → Codex 实现门循环至收敛。

## 验收清单

- [ ] SYSTEM_CHANNEL_PORTS satisfies + 表值锁；新增端口=1 行
- [ ] channelEdgeDataflowSkip 语义格全绿（先钉后收顺序留痕）
- [ ] 五个私有拷贝消亡 + grep 棘轮
- [ ] isClarifyChannelEdge 字节等价（消费者零改动）
- [ ] 门禁 + CI + Codex 双门
