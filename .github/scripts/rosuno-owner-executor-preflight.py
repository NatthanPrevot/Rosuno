#!/usr/bin/env python3
"""Inert owner executor preflight. Never obtains grants, publishes or modifies state.

Input contexts are read-only authenticated GitHub API responses from an already
trusted source. GitHub authentication is NOT established by an arbitrary JSON file.
"""
import argparse
import json
from pathlib import Path
import re
import sys

OWNER = 'NatthanPrevot/Rosuno'
FORK = 'RosunoBackup/Rosuno'
OWNER_ID = 1349842353
FORK_ID = 1413917279
PACKET_HEAD = 'a75967e7e787a09c8f00d2259298d2b078291a01'
BASE = '18e040a56e388b8e840c4ec5475f0451551d9fcf'
BRANCH = 'wi/P2-905-claude-workflow-controls-v1'

class PreflightError(Exception):
    pass

def require(ok, why):
    if not ok:
        raise PreflightError(why)

def check_context(data):
    require(isinstance(data, dict) and set(data) == {'owner_repo', 'fork_repo', 'owner_branch', 'fork_branch', 'viewer', 'grant'}, 'unexpected context schema')
    owner, fork = data['owner_repo'], data['fork_repo']
    require(owner.get('id') == OWNER_ID and owner.get('full_name') == OWNER and owner.get('default_branch') == 'main', 'owner repository mismatch')
    require(fork.get('id') == FORK_ID and fork.get('full_name') == FORK and fork.get('default_branch') == 'main', 'fork repository mismatch')
    require(fork.get('fork') is True and fork.get('parent', {}).get('id') == OWNER_ID, 'fork parent mismatch')
    for repo in (owner, fork):
        require(repo.get('main_head') == BASE, 'main has moved')
    require(data['owner_branch'] == '5db861d13efb7a46f33da418526d368182c7f0c3', 'owner Packet branch changed')
    require(data['fork_branch'] == PACKET_HEAD, 'fork Packet branch changed')
    # Never infer principal from env token existence, branch author, or credential name.
    require(data['viewer'].get('login') == 'RosunoBackup' and isinstance(data['viewer'].get('id'), int), 'authenticated actor not Builder fork user')
    grant = data['grant']
    require(isinstance(grant, dict) and grant.get('work_item') == 'P2-905' and grant.get('branch') == BRANCH, 'wrong grant work item')
    require(grant.get('head') == PACKET_HEAD and grant.get('base') == BASE, 'grant source stale')
    require(grant.get('owner_executor_enabled') is False, 'owner executor must stay disabled')
    require(grant.get('bot_pr_enabled') is False and grant.get('cloud_gate7_enabled') is False, 'unauthorized automation permission')
    return 'HOLD — identity and schema validated, owner executor DISABLED pending separate commissioning'

def main(argv=None):
    ap = argparse.ArgumentParser(description='P2-905 read-only disabled owner-executor gate')
    ap.add_argument('--context', required=True)
    ap.add_argument('--inspect-only', action='store_true', required=True)
    a = ap.parse_args(argv)
    data = json.loads(Path(a.context).read_text(encoding='utf-8'))
    print(check_context(data))
    return 2  # mandatory HOLD: a passing identity check never authorizes an executor

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, PreflightError) as error:
        print('::error::ROSUNO-OWNER-EXECUTOR HOLD: ' + str(error), file=sys.stderr)
        sys.exit(1)
