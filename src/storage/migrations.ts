import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 30;

const CURRENT_SCHEMA_SQL = `
CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT,
          status TEXT NOT NULL DEFAULT 'created',
          summary TEXT DEFAULT '',
          snapshot_json TEXT DEFAULT '[]',
          resources_json TEXT DEFAULT '[]',
          dependencies_json TEXT DEFAULT '[]',
          priority_json TEXT,
          injected_prefs_json TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , last_scheduling_reason TEXT DEFAULT '', last_interruption_reason TEXT DEFAULT '', interruption_count INTEGER DEFAULT 0, artifacts_json TEXT DEFAULT '[]');

CREATE TABLE preferences (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope TEXT NOT NULL,
          subject TEXT,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'observed',
          confidence REAL DEFAULT 0,
          occurrence_count INTEGER DEFAULT 1,
          source_tasks TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT,
          confirmed_at TEXT
        );

CREATE TABLE preference_usage (
          id TEXT PRIMARY KEY,
          preference_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          injected_at TEXT NOT NULL,
          was_overridden INTEGER DEFAULT 0,
          FOREIGN KEY (preference_id) REFERENCES preferences(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE TABLE interactions (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          user_input TEXT,
          system_output TEXT,
          executor_used TEXT,
          created_at TEXT NOT NULL
        , session_id TEXT);

CREATE TABLE guidance_events (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        task_id TEXT,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL DEFAULT 0,
        requires_confirmation INTEGER DEFAULT 1,
        accepted_at TEXT,
        dismissed_at TEXT,
        executed_at TEXT,
        created_at TEXT NOT NULL
      );

CREATE TABLE session_state (
        id TEXT PRIMARY KEY,
        last_focused_task_id TEXT,
        last_completed_task_id TEXT,
        last_session_id TEXT,
        updated_at TEXT NOT NULL
      );

CREATE TABLE reflection_events (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT,
        task_id TEXT,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

CREATE TABLE learning_candidates (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_reflection_id TEXT,
        source_task_id TEXT,
        safety_status TEXT NOT NULL DEFAULT 'pending',
        safety_reasons_json TEXT NOT NULL DEFAULT '[]',
        review_note TEXT,
        promoted_asset_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE executor_skill_usage_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        executor_name TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_version TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

CREATE TABLE executor_skill_install_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        package_id TEXT,
        executor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

CREATE TABLE task_memory_cards (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_decisions_json TEXT NOT NULL DEFAULT '[]',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        verification_commands_json TEXT NOT NULL DEFAULT '[]',
        pitfalls_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT 'success',
        source_candidate_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE skill_effect_summaries (
        id TEXT PRIMARY KEY,
        executor_name TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_version TEXT,
        skill_version_key TEXT GENERATED ALWAYS AS (COALESCE(skill_version, '')) STORED,
        used_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        helpful_count INTEGER NOT NULL DEFAULT 0,
        patch_candidate_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL,
        last_failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(executor_name, skill_name, skill_version_key)
      );

CREATE TABLE executor_route_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT NOT NULL,
        selected_executor TEXT NOT NULL,
        action TEXT NOT NULL,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        primary_intent TEXT NOT NULL DEFAULT 'general',
        matched_boundary_json TEXT NOT NULL DEFAULT '[]',
        rejected_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        created_at TEXT NOT NULL
      );

CREATE VIRTUAL TABLE task_search_index USING fts5(
        task_id UNINDEXED,
        source_kind UNINDEXED,
        source_id UNINDEXED,
        title,
        body,
        tags,
        created_at UNINDEXED,
        updated_at UNINDEXED,
        tokenize = 'trigram'
      );

CREATE TABLE agent_classes (
          name TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'executor',
          domains_json TEXT NOT NULL DEFAULT '[]',
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          input_types_json TEXT NOT NULL DEFAULT '[]',
          output_types_json TEXT NOT NULL DEFAULT '[]',
          strengths_json TEXT NOT NULL DEFAULT '[]',
          weaknesses_json TEXT NOT NULL DEFAULT '[]',
          primary_use_cases_json TEXT NOT NULL DEFAULT '[]',
          avoid_use_cases_json TEXT NOT NULL DEFAULT '[]',
          intent_affinity_json TEXT NOT NULL DEFAULT '{}',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          availability TEXT NOT NULL DEFAULT 'available',
          harness TEXT,
          model TEXT,
          skills_json TEXT NOT NULL DEFAULT '[]',
          mcp_servers_json TEXT NOT NULL DEFAULT '[]',
          plugins_json TEXT NOT NULL DEFAULT '[]',
          runtime_command TEXT,
          runtime_args_json TEXT NOT NULL DEFAULT '[]',
          runtime_check_command TEXT,
          project_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , execution_image_ref TEXT, resolved_image_id TEXT, permission_profile_id TEXT);

CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          subtask_id TEXT,
          event_type TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE TABLE work_units (
          id TEXT PRIMARY KEY,
          agent_class_name TEXT NOT NULL,
          agent_class_kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'starting',
          claimed_task_id TEXT,
          claimed_subtask_id TEXT,
          heartbeat_at TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, claimed_attempt_id TEXT,
          FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
        );

CREATE TABLE work_unit_events (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          task_id TEXT,
          subtask_id TEXT,
          event_type TEXT NOT NULL,
          state TEXT,
          message TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL, attempt_id TEXT,
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
        );

CREATE TABLE planner_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_source TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

CREATE TABLE planner_proposal_turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        user_input TEXT NOT NULL,
        accepted_submission_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );

CREATE TABLE planner_proposal_submissions (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        plan_id TEXT,
        event_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('submitting', 'uncertain', 'accepted', 'rejected')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id, submission_id),
        UNIQUE (event_id),
        FOREIGN KEY (session_id, turn_id)
          REFERENCES planner_proposal_turns(session_id, turn_id) ON DELETE CASCADE
      );
CREATE INDEX idx_planner_proposal_submissions_turn
  ON planner_proposal_submissions(session_id, turn_id, created_at);

CREATE TABLE planner_tool_calls (
        id TEXT PRIMARY KEY,
        planner_run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        arguments_summary_json TEXT NOT NULL DEFAULT '{}',
        result_summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (planner_run_id) REFERENCES planner_runs(id)
      );

CREATE TABLE kernel_executor_status (
        agent_class_name TEXT PRIMARY KEY,
        class_health TEXT NOT NULL DEFAULT 'unverified',
        recent_attempts_json TEXT NOT NULL DEFAULT '[]',
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
      );

CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          context_refs_json TEXT NOT NULL DEFAULT '[]',
          required_capabilities_json TEXT NOT NULL,
          preferred_agent_class_list_json TEXT NOT NULL,
          delivery_kind TEXT NOT NULL DEFAULT 'report' CHECK(delivery_kind IN ('edit', 'report')),
          acceptance_json TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          result TEXT NOT NULL DEFAULT '',
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          verification_json TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, graph_revision INTEGER, generation_id TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE TABLE subtask_handoffs (
          task_id TEXT NOT NULL,
          from_subtask_id TEXT NOT NULL,
          to_subtask_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          items_json TEXT NOT NULL,
          completion_schema_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, from_subtask_id, to_subtask_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (from_subtask_id) REFERENCES subtasks(id),
          FOREIGN KEY (to_subtask_id) REFERENCES subtasks(id)
        );

CREATE TABLE executor_attempt_receipts (
          attempt_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          subtask_id TEXT NOT NULL,
          work_unit_id TEXT NOT NULL,
          agent_class_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          terminal_state TEXT NOT NULL,
          raw_response TEXT NOT NULL,
          completion_schema_version INTEGER,
          parsing_json TEXT NOT NULL DEFAULT '{}',
          verification_json TEXT NOT NULL DEFAULT '{}',
          error_code TEXT,
          error_detail TEXT, graph_revision INTEGER, generation_id TEXT, attempt_kind TEXT NOT NULL DEFAULT 'primary', source_attempt_id TEXT, failure_json TEXT, recovery_mode TEXT NOT NULL DEFAULT 'fresh',
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
        );

CREATE TABLE task_execution_evidence (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_id TEXT,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          exact_only INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE TABLE kernel_decisions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          causation_id TEXT,
          session_id TEXT NOT NULL,
          task_id TEXT,
          subtask_id TEXT,
          attempt_id TEXT,
          event_json TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          action TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

CREATE TABLE kernel_events (
            id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            correlation_id TEXT NOT NULL,
            causation_id TEXT,
            session_id TEXT NOT NULL,
            task_id TEXT,
            subtask_id TEXT,
            attempt_id TEXT,
            event_json TEXT NOT NULL,
            available_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            processing_started_at TEXT,
            processed_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

CREATE TABLE kernel_decision_applications (
            id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL UNIQUE,
            event_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending',
            apply_attempts INTEGER NOT NULL DEFAULT 0,
            observation_event_id TEXT,
            observation_event_json TEXT,
            error_summary TEXT,
            applying_at TEXT,
            applied_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (decision_id) REFERENCES kernel_decisions(id),
            FOREIGN KEY (event_id) REFERENCES kernel_events(id)
          );

CREATE TABLE kernel_effect_outbox (
            id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL,
            task_id TEXT,
            effect_type TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            delivery_attempts INTEGER NOT NULL DEFAULT 0,
            provider_receipt TEXT,
            error_summary TEXT,
            available_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (decision_id) REFERENCES kernel_decisions(id)
          );

CREATE TABLE executor_attempt_runtime (
            attempt_id TEXT PRIMARY KEY,
            source_attempt_id TEXT,
            continuation_token TEXT,
            workspace_root TEXT,
            workspace_baseline_json TEXT NOT NULL DEFAULT '{}',
            workspace_delta_json TEXT NOT NULL DEFAULT '{}',
            progress_json TEXT NOT NULL DEFAULT '{}',
            recovery_safety TEXT NOT NULL,
            external_idempotency_key TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

CREATE TABLE work_graph_revisions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            generation_id TEXT NOT NULL,
            authorized_decision_id TEXT,
            proposal_source TEXT NOT NULL DEFAULT 'initial',
            automatic_replan INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, completion_kind TEXT CHECK(completion_kind IN ('full', 'partial_accepted')),
            UNIQUE(task_id, revision),
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (authorized_decision_id) REFERENCES kernel_decisions(id)
          );

CREATE TABLE resource_leases (
            id TEXT PRIMARY KEY,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            access_mode TEXT NOT NULL CHECK(access_mode IN ('read', 'write')),
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            work_unit_id TEXT NOT NULL,
            lease_token TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            released_at TEXT,
            created_at TEXT NOT NULL, revocation_requested_at TEXT, revocation_reason TEXT,
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
            FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
          );

CREATE TABLE resource_waits (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            access_mode TEXT NOT NULL CHECK(access_mode IN ('read', 'write')),
            conflicting_lease_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'waiting',
            requested_at TEXT NOT NULL,
            resolved_at TEXT,
            UNIQUE(attempt_id, partition_key, access_mode)
          );

CREATE TABLE workspace_records (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            workspace_kind TEXT NOT NULL CHECK(workspace_kind IN ('git', 'directory')),
            root_uri TEXT NOT NULL,
            baseline_json TEXT NOT NULL DEFAULT '{}',
            managed_repository_uri TEXT,
            managed_branch TEXT,
            head_commit TEXT,
            current_checkpoint_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            cleanup_after TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, generation_id, subtask_id)
          );

CREATE TABLE workspace_checkpoints (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            attempt_id TEXT,
            reason TEXT NOT NULL CHECK(reason IN ('attempt_start', 'explicit', 'permission_suspended', 'success', 'failure', 'cancelled')),
            manifest_uri TEXT NOT NULL,
            manifest_hash TEXT NOT NULL,
            manifest_size INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspace_records(id)
          );

CREATE TABLE workspace_objects (
            content_hash TEXT PRIMARY KEY,
            object_uri TEXT NOT NULL UNIQUE,
            size_bytes INTEGER NOT NULL,
            media_type TEXT,
            reference_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_referenced_at TEXT NOT NULL
          );

CREATE TABLE workspace_checkpoint_objects (
            checkpoint_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            PRIMARY KEY(checkpoint_id, content_hash),
            FOREIGN KEY(checkpoint_id) REFERENCES workspace_checkpoints(id) ON DELETE CASCADE,
            FOREIGN KEY(content_hash) REFERENCES workspace_objects(content_hash)
          );

CREATE TABLE permission_requests (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            agent_class_name TEXT NOT NULL,
            permission_profile_id TEXT NOT NULL,
            capability TEXT NOT NULL,
            resource_text TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            operation TEXT NOT NULL,
            reason TEXT NOT NULL,
            suggested_scope TEXT NOT NULL CHECK(suggested_scope IN ('once', 'attempt')),
            distinct_request_ordinal INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            decision_id TEXT,
            decision_reason TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            UNIQUE(attempt_id, fingerprint)
          );

CREATE TABLE permission_grants (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            fingerprint TEXT NOT NULL,
            decision_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            capability TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            operation TEXT NOT NULL,
            grant_scope TEXT NOT NULL CHECK(grant_scope IN ('once', 'attempt')),
            expires_at TEXT NOT NULL,
            max_calls INTEGER NOT NULL,
            calls_used INTEGER NOT NULL DEFAULT 0,
            max_bytes INTEGER NOT NULL,
            bytes_used INTEGER NOT NULL DEFAULT 0,
            revoked_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (request_id) REFERENCES permission_requests(id),
            FOREIGN KEY (decision_id) REFERENCES kernel_decisions(id)
          );

CREATE TABLE user_authorizations (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            task_id TEXT NOT NULL,
            resolution TEXT NOT NULL CHECK(resolution IN ('approve', 'deny')),
            source TEXT NOT NULL,
            planner_plan_id TEXT,
            received_event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            UNIQUE(request_id, received_event_id),
            FOREIGN KEY (request_id) REFERENCES permission_requests(id)
          );

CREATE TABLE attempt_sandboxes (
            attempt_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            work_unit_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            container_id TEXT NOT NULL UNIQUE,
            image_ref TEXT NOT NULL,
            image_id TEXT NOT NULL,
            status TEXT NOT NULL,
            lease_token TEXT NOT NULL,
            labels_json TEXT NOT NULL,
            exit_code INTEGER,
            result_collected_at TEXT,
            cleanup_status TEXT,
            cleanup_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspace_records(id)
          );

CREATE TABLE workspace_merge_attempts (
            id TEXT PRIMARY KEY,
            publication_id TEXT NOT NULL,
            decision_id TEXT NOT NULL,
            attempt_id TEXT,
            ordinal INTEGER NOT NULL,
            attempt_kind TEXT NOT NULL CHECK(attempt_kind IN ('automatic', 'repair')),
            base_commit TEXT NOT NULL,
            ours_commit TEXT NOT NULL,
            theirs_commit TEXT NOT NULL,
            conflict_paths_json TEXT NOT NULL DEFAULT '[]',
            file_policy_json TEXT NOT NULL DEFAULT '{}',
            result TEXT NOT NULL CHECK(result IN ('integrated', 'conflicted', 'failed', 'uncertain')),
            integration_commit TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(publication_id, ordinal),
            FOREIGN KEY (publication_id) REFERENCES workspace_publications(id)
          );

CREATE TABLE "kernel_dispatch_items" (
            attempt_id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL,
            batch_order INTEGER NOT NULL,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            agent_class_name TEXT NOT NULL,
            attempt_kind TEXT NOT NULL CHECK(attempt_kind IN (
              'primary', 'continuation', 'fallback', 'contract_correction', 'merge_repair'
            )),
            source_attempt_id TEXT,
            recovery_mode TEXT NOT NULL CHECK(recovery_mode IN (
              'native_session', 'recovery_packet', 'fresh'
            )),
            attempt_payload_json TEXT NOT NULL DEFAULT 'null',
            resource_grant_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL CHECK(status IN (
              'pending_launch', 'launching', 'running', 'cancelling',
              'terminal', 'cancelled', 'uncertain'
            )),
            work_unit_id TEXT,
            sandbox_container_id TEXT,
            launch_started_at TEXT,
            terminal_at TEXT,
            cancellation_decision_id TEXT,
            cancel_requested_at TEXT,
            cancelled_at TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (subtask_id) REFERENCES subtasks(id)
          );

CREATE TABLE "workspace_publications" (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            source_attempt_id TEXT NOT NULL,
            agent_class_name TEXT NOT NULL,
            candidate_commit TEXT NOT NULL,
            original_completion_json TEXT NOT NULL,
            topology_layer INTEGER NOT NULL,
            first_dispatch_order INTEGER NOT NULL,
            repair_attempts_used INTEGER NOT NULL DEFAULT 0,
            conflict_replans_used INTEGER NOT NULL DEFAULT 0,
            conflict_chain_id TEXT,
            integration_commit TEXT,
            observed_integration_commit TEXT,
            status TEXT NOT NULL CHECK(status IN (
              'pending', 'applying', 'conflicted', 'integrated', 'parked',
              'cancelling', 'cancelled', 'uncertain'
            )),
            applying_at TEXT,
            integrated_at TEXT,
            cancellation_decision_id TEXT,
            cancel_requested_at TEXT,
            cancelled_at TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, generation_id, subtask_id),
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (subtask_id) REFERENCES subtasks(id)
          );

CREATE TABLE generation_replan_requests (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            source_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
              'pending_quiescence', 'planning', 'submitted', 'waiting_for_availability',
              'resolved', 'cancelled', 'failed'
            )),
            trigger_decision_id TEXT NOT NULL,
            quiescence_token TEXT,
            error_summary TEXT,
            deferred_plan_json TEXT,
            availability_explanation TEXT,
            planning_started_at TEXT,
            submitted_at TEXT,
            resolved_at TEXT,
            cancelled_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, generation_id, source_revision),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
          );

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_preferences_scope ON preferences(scope);

CREATE INDEX idx_preferences_status ON preferences(status);

CREATE INDEX idx_interactions_session ON interactions(session_id, created_at);

CREATE INDEX idx_interactions_task ON interactions(task_id, created_at);

CREATE INDEX idx_guidance_events_task ON guidance_events(task_id, created_at);

CREATE INDEX idx_reflection_events_task
        ON reflection_events(task_id, created_at);

CREATE INDEX idx_reflection_events_source
        ON reflection_events(source_type, source_id);

CREATE INDEX idx_learning_candidates_status
        ON learning_candidates(status, created_at);

CREATE INDEX idx_learning_candidates_source_task
        ON learning_candidates(source_task_id, created_at);

CREATE INDEX idx_skill_usage_events_task
        ON executor_skill_usage_events(task_id, created_at);

CREATE INDEX idx_skill_usage_events_execution
        ON executor_skill_usage_events(execution_id, created_at);

CREATE INDEX idx_skill_usage_events_skill
        ON executor_skill_usage_events(skill_name, event_type, created_at);

CREATE INDEX idx_skill_install_events_candidate
        ON executor_skill_install_events(candidate_id, created_at);

CREATE INDEX idx_skill_install_events_executor
        ON executor_skill_install_events(executor_name, status, created_at);

CREATE INDEX idx_task_memory_cards_task
        ON task_memory_cards(task_id, updated_at);

CREATE INDEX idx_task_memory_cards_source_candidate
        ON task_memory_cards(source_candidate_id);

CREATE INDEX idx_skill_effect_summaries_skill
        ON skill_effect_summaries(skill_name, skill_version_key, updated_at);

CREATE INDEX idx_skill_effect_summaries_executor
        ON skill_effect_summaries(executor_name, used_count, updated_at);

CREATE INDEX idx_executor_route_events_executor
        ON executor_route_events(selected_executor, created_at);

CREATE INDEX idx_executor_route_events_task
        ON executor_route_events(task_id, created_at);

CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);

CREATE INDEX idx_work_units_state ON work_units(agent_class_kind, state, updated_at);

CREATE INDEX idx_work_unit_events_unit ON work_unit_events(work_unit_id, created_at);

CREATE INDEX idx_planner_runs_session
        ON planner_runs(session_id, created_at);

CREATE INDEX idx_planner_tool_calls_run
        ON planner_tool_calls(planner_run_id, sequence);

CREATE INDEX idx_subtasks_task ON subtasks(task_id, status, created_at);

CREATE INDEX idx_subtask_handoffs_to ON subtask_handoffs(task_id, to_subtask_id);

CREATE INDEX idx_executor_attempt_receipts_subtask
          ON executor_attempt_receipts(task_id, subtask_id, completed_at);

CREATE INDEX idx_task_execution_evidence_task
          ON task_execution_evidence(task_id, created_at, id);

CREATE UNIQUE INDEX idx_work_units_one_active_attempt_per_subtask
          ON work_units(claimed_subtask_id)
          WHERE claimed_subtask_id IS NOT NULL AND state IN ('claimed', 'running', 'waiting');

CREATE INDEX idx_kernel_decisions_session
          ON kernel_decisions(session_id, created_at, id);

CREATE INDEX idx_kernel_decisions_task
          ON kernel_decisions(task_id, created_at, id);

CREATE INDEX idx_kernel_decisions_correlation
          ON kernel_decisions(correlation_id, created_at, id);

CREATE INDEX idx_kernel_events_drain
            ON kernel_events(status, available_at, created_at, id);

CREATE INDEX idx_kernel_events_task
            ON kernel_events(task_id, created_at, id);

CREATE INDEX idx_kernel_decision_applications_status
            ON kernel_decision_applications(status, created_at, id);

CREATE INDEX idx_kernel_effect_outbox_drain
            ON kernel_effect_outbox(status, available_at, created_at, id);

CREATE UNIQUE INDEX idx_work_graph_one_active_revision
            ON work_graph_revisions(task_id) WHERE status = 'active';

CREATE INDEX idx_work_graph_revisions_generation
            ON work_graph_revisions(task_id, generation_id, revision);

CREATE INDEX idx_resource_leases_active
            ON resource_leases(released_at, expires_at, partition_key);

CREATE INDEX idx_resource_leases_attempt
            ON resource_leases(attempt_id, released_at);

CREATE UNIQUE INDEX idx_resource_leases_identity
            ON resource_leases(attempt_id, lease_token, partition_key, access_mode);

CREATE INDEX idx_resource_waits_status
            ON resource_waits(status, requested_at);

CREATE INDEX idx_workspace_records_retention
            ON workspace_records(status, cleanup_after);

CREATE INDEX idx_workspace_checkpoints_workspace
            ON workspace_checkpoints(workspace_id, created_at);

CREATE INDEX idx_permission_requests_pending
            ON permission_requests(status, task_id, created_at);

CREATE INDEX idx_permission_grants_attempt
            ON permission_grants(attempt_id, expires_at, revoked_at);

CREATE INDEX idx_user_authorizations_request
            ON user_authorizations(request_id, created_at);

CREATE INDEX idx_attempt_sandboxes_status
            ON attempt_sandboxes(status, updated_at);

CREATE INDEX idx_workspace_merge_attempts_publication
            ON workspace_merge_attempts(publication_id, ordinal);

CREATE INDEX idx_kernel_dispatch_items_supervisor
            ON kernel_dispatch_items(status, batch_order, created_at, attempt_id);

CREATE INDEX idx_kernel_dispatch_items_task
            ON kernel_dispatch_items(task_id, status, batch_order);

CREATE UNIQUE INDEX idx_kernel_dispatch_one_active_subtask
            ON kernel_dispatch_items(task_id, generation_id, subtask_id)
            WHERE status IN ('pending_launch', 'launching', 'running', 'cancelling');

CREATE INDEX idx_workspace_publications_apply
            ON workspace_publications(
              task_id, generation_id, status, topology_layer,
              first_dispatch_order, subtask_id
            );

CREATE INDEX idx_generation_replan_requests_status
            ON generation_replan_requests(status, created_at, id);

CREATE INDEX idx_generation_replan_requests_task
            ON generation_replan_requests(task_id, generation_id, status);

CREATE TRIGGER trg_task_search_index_interactions_insert
      AFTER INSERT ON interactions
      WHEN NEW.task_id IS NOT NULL
      BEGIN
        DELETE FROM task_search_index
          WHERE source_kind = 'interaction' AND source_id = NEW.id;
        INSERT INTO task_search_index (
          task_id, source_kind, source_id, title, body, tags, created_at, updated_at
        ) VALUES (
          NEW.task_id,
          'interaction',
          NEW.id,
          '',
          substr(COALESCE(NEW.user_input, '') || char(10) || COALESCE(NEW.system_output, ''), 1, 4000),
          'interaction',
          NEW.created_at,
          NEW.created_at
        );
      END;

CREATE TRIGGER trg_task_search_index_interactions_delete
      AFTER DELETE ON interactions
      WHEN OLD.task_id IS NOT NULL
      BEGIN
        DELETE FROM task_search_index
          WHERE source_kind = 'interaction' AND source_id = OLD.id;
      END;

CREATE TRIGGER subtask_handoffs_immutable_update
        BEFORE UPDATE ON subtask_handoffs BEGIN
          SELECT RAISE(ABORT, 'subtask_handoffs are immutable');
        END;

CREATE TRIGGER subtask_handoffs_immutable_delete
        BEFORE DELETE ON subtask_handoffs BEGIN
          SELECT RAISE(ABORT, 'subtask_handoffs are immutable');
        END;

CREATE TRIGGER executor_attempt_receipts_immutable_update
        BEFORE UPDATE ON executor_attempt_receipts BEGIN
          SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
        END;

CREATE TRIGGER executor_attempt_receipts_immutable_delete
        BEFORE DELETE ON executor_attempt_receipts BEGIN
          SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
        END;

CREATE TRIGGER workspace_checkpoints_immutable_update
          BEFORE UPDATE ON workspace_checkpoints BEGIN
            SELECT RAISE(ABORT, 'workspace checkpoints are immutable');
          END;

CREATE TRIGGER workspace_merge_attempts_immutable_update
          BEFORE UPDATE ON workspace_merge_attempts BEGIN
            SELECT RAISE(ABORT, 'workspace_merge_attempts are immutable');
          END;

CREATE TRIGGER workspace_merge_attempts_immutable_delete
          BEFORE DELETE ON workspace_merge_attempts BEGIN
            SELECT RAISE(ABORT, 'workspace_merge_attempts are immutable');
          END;
`;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { name: string } | undefined;
  return Boolean(row);
}

/**
 * Creates the only supported pre-release schema.
 *
 * MetaClaw has not shipped a compatible database format yet. Existing
 * pre-release databases fail closed instead of running upgrade or dual-read
 * paths; callers must create a fresh database.
 */
export function runMigrations(db: Database.Database): void {
  if (tableExists(db, 'schema_version')) {
    const versions = db.prepare(
      'SELECT version FROM schema_version ORDER BY version',
    ).all() as Array<{ version: number }>;
    if (versions.length === 1 && versions[0]?.version === CURRENT_SCHEMA_VERSION) {
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 29) {
      migrateSchema29To30(db);
      return;
    }
    const found = versions.map(row => row.version).join(', ') || 'empty';
    throw new Error(
      `unsupported pre-release SQLite schema (${found}); create a fresh database for schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  const existing = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  if (existing.length > 0) {
    throw new Error(
      `unsupported pre-release SQLite database without schema_version (${existing.map(row => row.name).join(', ')})`,
    );
  }

  db.transaction(() => {
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    db.exec(CURRENT_SCHEMA_SQL);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)')
      .run(CURRENT_SCHEMA_VERSION);
  })();
}

function migrateSchema29To30(db: Database.Database): void {
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  const migrate = db.transaction(() => {
    const invalidKinds = db.prepare(`
      SELECT id, expected_output AS expectedOutput
      FROM subtasks
      WHERE expected_output NOT IN ('patch', 'artifact', 'analysis', 'review', 'summary')
      ORDER BY id
    `).all() as Array<{ id: string; expectedOutput: string }>;
    if (invalidKinds.length > 0) {
      throw new Error(
        `schema 29 subtask output cannot be migrated: ${invalidKinds.map(item => `${item.id}=${item.expectedOutput}`).join(', ')}`,
      );
    }

    migrateRecoverableJson(db);
    db.exec(`
      PRAGMA defer_foreign_keys = ON;
      CREATE TABLE subtasks_v30 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        context_refs_json TEXT NOT NULL DEFAULT '[]',
        required_capabilities_json TEXT NOT NULL,
        preferred_agent_class_list_json TEXT NOT NULL,
        delivery_kind TEXT NOT NULL DEFAULT 'report' CHECK(delivery_kind IN ('edit', 'report')),
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        risk_level TEXT NOT NULL DEFAULT 'medium',
        result TEXT NOT NULL DEFAULT '',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        graph_revision INTEGER,
        generation_id TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      INSERT INTO subtasks_v30 (
        id, task_id, title, goal, status, dependencies_json, context_refs_json,
        required_capabilities_json, preferred_agent_class_list_json, delivery_kind,
        acceptance_json, risk_level, result, artifacts_json, verification_json,
        error, created_at, updated_at, graph_revision, generation_id
      )
      SELECT
        id, task_id, title, goal, status, dependencies_json, context_refs_json,
        required_capabilities_json, preferred_agent_class_list_json,
        CASE
          WHEN expected_output IN ('patch', 'artifact') THEN 'edit'
          WHEN expected_output IN ('analysis', 'review', 'summary') THEN 'report'
        END,
        acceptance_json, risk_level, result, artifacts_json, verification_json,
        error, created_at, updated_at, graph_revision, generation_id
      FROM subtasks;
      DROP TABLE subtasks;
      ALTER TABLE subtasks_v30 RENAME TO subtasks;
      CREATE INDEX idx_subtasks_task ON subtasks(task_id, status, created_at);
    `);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error('schema 29 to 30 migration produced foreign key violations');
    }
    const updated = db.prepare('UPDATE schema_version SET version = 30 WHERE version = 29').run();
    if (updated.changes !== 1) throw new Error('schema version changed during 29 to 30 migration');
  });
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    migrate();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }
}

interface RecoverableJsonColumn {
  selectSql: string;
  updateSql: string;
  label: string;
}

function migrateRecoverableJson(db: Database.Database): void {
  const columns: RecoverableJsonColumn[] = [
    {
      label: 'kernel_events.event_json',
      selectSql: `SELECT rowid AS rowId, event_json AS value FROM kernel_events WHERE status IN ('pending', 'processing')`,
      updateSql: 'UPDATE kernel_events SET event_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decisions.event_json',
      selectSql: `SELECT decision.rowid AS rowId, decision.event_json AS value
        FROM kernel_decisions decision
        JOIN kernel_decision_applications application ON application.decision_id = decision.id
        WHERE application.status <> 'applied'`,
      updateSql: 'UPDATE kernel_decisions SET event_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decisions.snapshot_json',
      selectSql: `SELECT decision.rowid AS rowId, decision.snapshot_json AS value
        FROM kernel_decisions decision
        JOIN kernel_decision_applications application ON application.decision_id = decision.id
        WHERE application.status <> 'applied'`,
      updateSql: 'UPDATE kernel_decisions SET snapshot_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decisions.decision_json',
      selectSql: `SELECT decision.rowid AS rowId, decision.decision_json AS value
        FROM kernel_decisions decision
        JOIN kernel_decision_applications application ON application.decision_id = decision.id
        WHERE application.status <> 'applied'`,
      updateSql: 'UPDATE kernel_decisions SET decision_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decision_applications.observation_event_json',
      selectSql: `SELECT rowid AS rowId, observation_event_json AS value
        FROM kernel_decision_applications
        WHERE status <> 'applied' AND observation_event_json IS NOT NULL`,
      updateSql: 'UPDATE kernel_decision_applications SET observation_event_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_dispatch_items.attempt_payload_json',
      selectSql: `SELECT rowid AS rowId, attempt_payload_json AS value
        FROM kernel_dispatch_items WHERE status NOT IN ('terminal', 'cancelled')`,
      updateSql: 'UPDATE kernel_dispatch_items SET attempt_payload_json = ? WHERE rowid = ?',
    },
    {
      label: 'generation_replan_requests.deferred_plan_json',
      selectSql: `SELECT rowid AS rowId, deferred_plan_json AS value
        FROM generation_replan_requests
        WHERE status NOT IN ('resolved', 'cancelled', 'failed') AND deferred_plan_json IS NOT NULL`,
      updateSql: 'UPDATE generation_replan_requests SET deferred_plan_json = ? WHERE rowid = ?',
    },
  ];
  for (const column of columns) migrateJsonColumn(db, column);
}

function migrateJsonColumn(db: Database.Database, column: RecoverableJsonColumn): void {
  const rows = db.prepare(column.selectSql).all() as Array<{ rowId: number; value: string }>;
  const update = db.prepare(column.updateSql);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value) as unknown;
    } catch (error) {
      throw new Error(`${column.label} row ${row.rowId} contains invalid recoverable JSON`, { cause: error });
    }
    const migrated = migrateRecoverableValue(parsed, `${column.label}[${row.rowId}]`);
    if (migrated.changed) update.run(JSON.stringify(migrated.value), row.rowId);
  }
}

function migrateRecoverableValue(value: unknown, path: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const migrated = value.map((item, index) => {
      const result = migrateRecoverableValue(item, `${path}[${index}]`);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? migrated : value, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(source)) {
    if (key === 'expectedOutput') continue;
    const result = migrateRecoverableValue(item, `${path}.${key}`);
    target[key] = result.value;
    changed ||= result.changed;
  }
  if (Object.hasOwn(source, 'expectedOutput')) {
    const deliveryKind = migrateDeliveryKind(source.expectedOutput, `${path}.expectedOutput`);
    if (Object.hasOwn(source, 'deliveryKind') && source.deliveryKind !== deliveryKind) {
      throw new Error(`${path} contains conflicting expectedOutput and deliveryKind values`);
    }
    target.deliveryKind = deliveryKind;
    changed = true;
  }
  if (target.schemaVersion === 6 && isPlanningAgentPlan(target)) {
    target.schemaVersion = 7;
    changed = true;
  }
  return { value: changed ? target : value, changed };
}

function migrateDeliveryKind(value: unknown, path: string): 'edit' | 'report' {
  if (value === 'patch' || value === 'artifact') return 'edit';
  if (value === 'analysis' || value === 'review' || value === 'summary') return 'report';
  throw new Error(`${path} has unsupported value ${JSON.stringify(value)}`);
}

function isPlanningAgentPlan(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string'
    && typeof value.action === 'string'
    && Object.hasOwn(value, 'task')
    && Object.hasOwn(value, 'workGraph');
}
