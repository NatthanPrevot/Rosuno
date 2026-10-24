#!/usr/bin/env python3
"""Offline tests: owner executor is inert even when identity data is valid."""
import copy
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / 'rosuno-owner-executor-preflight.py'
spec = importlib.util.spec_from_file_location('rosuno_owner_executor_preflight', PATH)
pre = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pre)

def fixture():
    return {
        'owner_repo': {'id': pre.OWNER_ID, 'full_name': pre.OWNER, 'default_branch': 'main', 'main_head': pre.BASE},
        'fork_repo': {'id': pre.FORK_ID, 'full_name': pre.FORK, 'default_branch': 'main', 'fork': True, 'parent': {'id': pre.OWNER_ID}, 'main_head': pre.BASE},
        'owner_branch': '5db861d13efb7a46f33da418526d368182c7f0c3',
        'fork_branch': pre.PACKET_HEAD,
        'viewer': {'id': 9001, 'login': 'RosunoBackup'},
        'grant': {'work_item': 'P2-905', 'branch': pre.BRANCH, 'head': pre.PACKET_HEAD, 'base': pre.BASE,
                  'owner_executor_enabled': False, 'bot_pr_enabled': False, 'cloud_gate7_enabled': False},
    }

class OwnerExecutorPreflightTests(unittest.TestCase):
    def setUp(self):
        self.data = fixture()

    def refuse(self):
        with self.assertRaises(pre.PreflightError):
            pre.check_context(self.data)

    def test_positive_identity_does_not_authorize_mutation(self):
        self.assertIn('DISABLED', pre.check_context(self.data))

    def test_rejects_unknown_schema(self):
        self.data['extra'] = 'unexpected'; self.refuse()

    def test_rejects_wrong_owner_repo(self):
        self.data['owner_repo']['id'] += 1; self.refuse()

    def test_rejects_wrong_fork_parent(self):
        self.data['fork_repo']['parent']['id'] += 1; self.refuse()

    def test_rejects_wrong_fork_name(self):
        self.data['fork_repo']['full_name'] = pre.OWNER; self.refuse()

    def test_rejects_owner_main_movement(self):
        self.data['owner_repo']['main_head'] = '1'*40; self.refuse()

    def test_rejects_fork_main_movement(self):
        self.data['fork_repo']['main_head'] = '1'*40; self.refuse()

    def test_rejects_owner_packet_movement(self):
        self.data['owner_branch'] = '1'*40; self.refuse()

    def test_rejects_fork_packet_movement(self):
        self.data['fork_branch'] = '1'*40; self.refuse()

    def test_rejects_wrong_account(self):
        self.data['viewer']['login'] = 'NatthanPrevot'; self.refuse()

    def test_rejects_stale_grant(self):
        self.data['grant']['head'] = '1'*40; self.refuse()

    def test_rejects_proposed_enablement(self):
        self.data['grant']['owner_executor_enabled'] = True; self.refuse()

    def test_rejects_bot_pr_enablement(self):
        self.data['grant']['bot_pr_enabled'] = True; self.refuse()

    def test_rejects_cloud_gate7_enablement(self):
        self.data['grant']['cloud_gate7_enabled'] = True; self.refuse()

if __name__ == '__main__':
    unittest.main(verbosity=2)
