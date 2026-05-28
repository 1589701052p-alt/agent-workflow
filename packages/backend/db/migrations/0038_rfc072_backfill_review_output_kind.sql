-- RFC-072 follow-up — backfill node_run_outputs.kind for review-approved file
-- docs produced before the kind-persistence landed.
--
-- approved_doc is written by review nodes (services/review.ts), not by an agent
-- with outputKinds, so migration 0037 + the runner change never populated their
-- kind. When the reviewed upstream port was kind markdown_file, review stores
-- the worktree-relative path (not inline body) and doc_versions.source_file_path
-- is non-NULL — a reliable, non-heuristic marker that the approved_doc value is
-- a downloadable file. Backfill those rows to kind='markdown_file' so the Outputs
-- tab shows a Download button. Inline-markdown approvals (source_file_path NULL)
-- are left as text (kind stays NULL).
UPDATE node_run_outputs
SET kind = 'markdown_file'
WHERE port_name = 'approved_doc'
  AND kind IS NULL
  AND EXISTS (
    SELECT 1
    FROM doc_versions dv
    WHERE dv.review_node_run_id = node_run_outputs.node_run_id
      AND dv.source_file_path IS NOT NULL
  );
