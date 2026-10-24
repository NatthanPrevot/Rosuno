#!/usr/bin/env python3
"""Deterministic offline security tests for rosuno-process-guard.py."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1] / 'rosuno-process-guard.py'
spec = importlib.util.spec_from_file_location('rosuno_process_guard', PATH)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

HEAD = 'a' * 40
BASE = 'b' * 40
OWNER_ID = 246810
REPO_ID = 1349842353
BRANCH = 'wi/P2-905-claude-workflow-controls-v1'
NOW = dt.datetime(2026, 10, 23, 12, 0, tzinfo=dt.timezone.utc)

def fixture():
    identity = {'id': OWNER_ID, 'login': 'NatthanPrevot'}
    repository = {'full_name': 'NatthanPrevot/Rosuno', 'id': REPO_ID, 'default_branch': 'main'}
    pr = {
        'number': 9, 'state': 'open', 'user': identity,
        'base': {'ref': 'main', 'sha': BASE, 'repo': {'full_name': repository['full_name'], 'id': REPO_ID}},
        'head': {'ref': BRANCH, 'sha': HEAD, 'repo': {'full_name': repository['full_name'], 'id': REPO_ID}},
    }
    event = {'repository': repository, 'pull_request': pr, 'sender': identity, 'action': 'edited'}
    prs = [{'number': 9, 'head': {'sha': HEAD}}]
    ctx = dict(pr=9, head=HEAD, base=BASE, branch=BRANCH, work_item='P2-905')
    body = dict(version=1, repo_id=REPO_ID, pr=9, head=HEAD, base=BASE, branch=BRANCH,
                work_item='P2-905', kind='PROCESS', expires_at='2026-10-24T10:00:00Z')
    comment = {'id': 123, 'user': identity, 'author_association': 'OWNER',
               'created_at': '2026-10-23T11:00:00Z', 'updated_at': '2026-10-23T11:00:00Z',
               'body': guard.GRANT_PREFIX + json.dumps(body, separators=(',', ':'))}
    return event, prs, ctx, [comment]

class ProcessGuardTests(unittest.TestCase):
    def setUp(self):
        self.event, self.prs, self.ctx, self.comments = fixture()

    def validate(self):
        return guard.inspect_event(self.event, self.prs, 'NatthanPrevot/Rosuno', REPO_ID, 'NatthanPrevot', OWNER_ID)

    def grant(self):
        return guard.inspect_grants(self.comments, self.ctx, REPO_ID, 'NatthanPrevot', OWNER_ID, 'PROCESS', NOW)

    def assert_denied(self, fn):
        with self.assertRaises(guard.GuardError):
            fn()

    def test_positive_authenticated_event_and_grant(self):
        self.assertEqual(self.validate(), self.ctx)
        self.assertEqual(self.grant(), 123)

    def test_denies_wrong_owner_repository(self):
        self.event['repository']['id'] = 42
        self.assert_denied(self.validate)

    def test_denies_wrong_base(self):
        self.event['pull_request']['base']['ref'] = 'staging'
        self.assert_denied(self.validate)

    def test_denies_wrong_head_source(self):
        self.event['pull_request']['head']['repo']['id'] = 1413917279
        self.assert_denied(self.validate)

    def test_denies_bot_pr_author(self):
        self.event['pull_request']['user'] = {'login': 'github-actions[bot]', 'id': 1}
        self.assert_denied(self.validate)

    def test_denies_wrong_event_sender(self):
        self.event['sender'] = {'login': 'RosunoBackup', 'id': 2}
        self.assert_denied(self.validate)

    def test_denies_action_from_unrecognized_event(self):
        self.event['action'] = 'closed'
        self.assert_denied(self.validate)

    def test_denies_ambiguous_pr_for_head(self):
        self.prs.append({'number': 10, 'head': {'sha': HEAD}})
        self.assert_denied(self.validate)

    def test_denies_moved_head(self):
        self.event['pull_request']['head']['sha'] = 'c' * 40
        self.assert_denied(self.validate)

    def test_denies_wrong_branch(self):
        self.event['pull_request']['head']['ref'] = 'another-branch'
        self.assert_denied(self.validate)

    def test_denies_spoofed_grant_actor(self):
        self.comments[0]['user']['id'] = 1
        self.assert_denied(self.grant)

    def test_denies_grant_wrong_head(self):
        body = json.loads(self.comments[0]['body'][len(guard.GRANT_PREFIX):]); body['head'] = 'f'*40
        self.comments[0]['body'] = guard.GRANT_PREFIX + json.dumps(body)
        self.assert_denied(self.grant)

    def test_denies_stale_expired_grant(self):
        self.assert_denied(lambda: guard.inspect_grants(self.comments, self.ctx, REPO_ID, 'NatthanPrevot', OWNER_ID, 'PROCESS', NOW + dt.timedelta(days=3)))

    def test_denies_grant_excessive_ttl(self):
        body = json.loads(self.comments[0]['body'][len(guard.GRANT_PREFIX):]); body['expires_at'] = '2026-10-29T12:00:00Z'
        self.comments[0]['body'] = guard.GRANT_PREFIX + json.dumps(body)
        self.assert_denied(self.grant)

    def test_denies_duplicate_grants(self):
        clone = copy.deepcopy(self.comments[0]); clone['id'] = 124
        self.comments.append(clone)
        self.assert_denied(self.grant)

    def test_denies_grant_extra_field(self):
        body = json.loads(self.comments[0]['body'][len(guard.GRANT_PREFIX):]); body['allow_bot'] = True
        self.comments[0]['body'] = guard.GRANT_PREFIX + json.dumps(body)
        self.assert_denied(self.grant)

    def test_denies_edited_grant(self):
        self.comments[0]['updated_at'] = '2026-10-23T11:01:00Z'
        self.assert_denied(self.grant)

    def test_denies_unsigned_grant(self):
        self.comments[0]['author_association'] = 'CONTRIBUTOR'
        self.assert_denied(self.grant)

    def test_packet_cardinality_and_type(self):
        src = 'WORK_ITEM: P2-905\nTYPE: PROCESS\nBRANCH: '+BRANCH+'\nBASE_SHA: '+BASE+'\nMIGRATIONS: none\nALLOWED_SCOPE:\n- CLAUDE.md\nFORBIDDEN_SCOPE:\n- .env\n'
        x = guard.packet_fields(src)
        self.assertEqual(x['TYPE'], 'PROCESS')
        self.assertEqual(x['ALLOWED_SCOPE'], ['CLAUDE.md'])
        self.assert_denied(lambda: guard.packet_fields(src + 'BASE_SHA: ' + BASE + '\n'))
        self.assert_denied(lambda: guard.packet_fields(src.replace('- CLAUDE.md', '- CLAUDE.md\n- claude.md')))

    def test_class_a_is_only_a_candidate(self):
        self.assertEqual(guard.classify_class_a('CA-905-1', '.github/scripts/rosuno-process-guard.py'), 'A_CANDIDATE_ONLY')
        self.assertEqual(guard.classify_class_a('CA-905-1', '.github/scripts/rosuno-guard.sh'), 'B')
        self.assertEqual(guard.classify_class_a('CA-905-2', 'CLAUDE.md'), 'B')
        self.assertEqual(guard.classify_class_a('CA-905-3', 'CLAUDE.md', semantic_change=True), 'B')
        self.assertEqual(guard.classify_class_a('CA-905-3', 'CLAUDE.md', unexplained=True), 'C')

    def test_runtime_disabled_by_default(self):
        self.assert_denied(lambda: guard.main(['--event', 'nope', '--open-prs', 'nope', '--comments', 'nope', '--owner-id', str(OWNER_ID)]))

if __name__ == '__main__':
    unittest.main(verbosity=2)
