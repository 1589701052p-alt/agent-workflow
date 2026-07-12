-- RFC-167 architecture pivot (2026-07-11) — DROP the dynamic_workflow_spaces
-- table introduced by 0088. The user reframed dynamic workflow as a THIRD
-- workgroup mode (leader_worker / free_collab / dynamic_workflow), not a
-- separate seventh resource, so the table + its ACL type are abandoned.
--
-- Forward drop (append-only) rather than editing 0088: 0088 already shipped to
-- the shared main branch, so its history is immutable — a fresh DB creates then
-- drops the (always-empty) table; an existing dev DB just drops it. No data
-- loss possible: no space rows were ever created (the resource never launched).
DROP TABLE IF EXISTS `dynamic_workflow_spaces`;
