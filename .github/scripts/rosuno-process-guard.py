#!/usr/bin/env python3
"""P2-905: trusted-default-branch PROCESS/closure PR guard. Read-only, fail closed.

Input JSONs MUST be sourced by the trusted owner-repository workflow from the
GitHub API, never from a pull-request checkout. This file does not grant any
permission or set a GitHub status. The runner alone decides whether to post.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HEX40 = re.compile(r"[0-9a-f]{40}\Z")
BRANCH = re.compile(r"wi/([A-Z][A-Z0-9]*-[0-9]{3})(?:-[a-z0-9-]+)?\Z")
GRANT_PREFIX = 'ROSUNO_PROCESS_GRANT_V1 '
GRANT_KEYS = frozenset({'version', 'repo_id', 'pr', 'head', 'base', 'branch', 'work_item', 'kind', 'expires_at'})
CLASS_A = {
    'CA-905-1': frozenset({'.github/scripts/rosuno-process-guard.py', '.github/scripts/rosuno-owner-executor-preflight.py'}),
    'CA-905-2': frozenset({'.github/scripts/tests/test-rosuno-process-guard.py', '.github/scripts/tests/test-rosuno-owner-executor-preflight.py'}),
    'CA-905-3': frozenset({'CLAUDE.md'}),
}

class GuardError(Exception):
    pass

def need(ok, message):
    if not ok:
        raise GuardError(message)

def utc(value):
    need(isinstance(value, str) and value.endswith('Z'), 'timestamp must be UTC Z')
    try:
        result = dt.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError as exc:
        raise GuardError('invalid timestamp') from exc
    need(result.utcoffset() == dt.timedelta(), 'timestamp offset invalid')
    return result

def classify_class_a(rule, path, semantic_change=False, unexplained=False):
    """Never confer authorization; classify a potential correction for human audit."""
    if unexplained:
        return 'C'
    if semantic_change or rule not in CLASS_A or path not in CLASS_A[rule]:
        return 'B'
    return 'A_CANDIDATE_ONLY'

def packet_fields(content):
    result = {}
    for key in ('WORK_ITEM', 'BRANCH', 'BASE_SHA', 'TYPE', 'MIGRATIONS', 'ALLOWED_SCOPE', 'FORBIDDEN_SCOPE'):
        matches = re.findall(r'^' + key + r':(?:[ \t]*(.*))?$', content, re.M)
        need(len(matches) == 1, f'Packet {key} must occur once')
        result[key] = matches[0].strip()
    for key in ('ALLOWED_SCOPE', 'FORBIDDEN_SCOPE'):
        lines = content.splitlines()
        pos = [i for i, line in enumerate(lines) if line == key + ':']
        need(len(pos) == 1, f'Packet {key} list malformed')
        values = []
        for line in lines[pos[0] + 1:]:
            if re.match(r'^[A-Z_]+:', line):
                break
            if line.startswith('- '):
                values.append(line[2:])
        need(bool(values), f'Packet {key} list empty')
        need(len(values) == len(set(values)) and len(values) == len(set(x.lower() for x in values)), 'duplicate scope entry')
        result[key] = values
    return result

def inspect_event(event, prs, owner_repo, owner_repo_id, owner_login, owner_id):
    need(event.get('repository', {}).get('full_name') == owner_repo, 'wrong repository')
    need(event['repository'].get('id') == owner_repo_id, 'wrong repository id')
    need(event['repository'].get('default_branch') == 'main', 'wrong default branch')
    pr = event.get('pull_request') or {}
    need(isinstance(pr.get('number'), int) and pr['number'] > 0, 'missing PR number')
    need(pr.get('state') == 'open', 'PR not open')
    need(pr.get('base', {}).get('ref') == 'main', 'wrong base branch')
    need(pr['base'].get('repo', {}).get('id') == owner_repo_id, 'wrong base repository id')
    need(pr['base']['repo'].get('full_name') == owner_repo, 'wrong base repo')
    head = pr.get('head') or {}
    need(head.get('repo', {}).get('id') == owner_repo_id, 'not an owner-origin head')
    need(head['repo'].get('full_name') == owner_repo, 'wrong head repository')
    need(pr.get('user', {}).get('login') == owner_login and pr['user'].get('id') == owner_id, 'PR creator not owner')
    sender = event.get('sender') or {}
    need(sender.get('login') == owner_login and sender.get('id') == owner_id, 'event sender not owner')
    need(event.get('action') in {'opened', 'edited', 'reopened', 'ready_for_review', 'synchronize'}, 'untrusted event action')
    headsha = head.get('sha')
    basesha = pr['base'].get('sha')
    need(isinstance(headsha, str) and HEX40.fullmatch(headsha), 'invalid head SHA')
    need(isinstance(basesha, str) and HEX40.fullmatch(basesha), 'invalid base SHA')
    match = BRANCH.fullmatch(head.get('ref', ''))
    need(match is not None, 'invalid work-item branch')
    need(isinstance(prs, list) and len(prs) > 0, 'missing open-PR listing')
    same = [p for p in prs if p.get('head', {}).get('sha') == headsha]
    need(len(same) == 1 and same[0].get('number') == pr['number'], 'ambiguous head PR')
    return {'pr': pr['number'], 'head': headsha, 'base': basesha, 'branch': head['ref'], 'work_item': match.group(1)}

def inspect_grants(comments, context, repo_id, owner_login, owner_id, kind, now):
    need(isinstance(comments, list), 'comments must be trusted API array')
    valid = []
    for comment in comments:
        body = comment.get('body')
        if not isinstance(body, str) or not body.startswith(GRANT_PREFIX):
            continue
        # A bad grant-looking comment is a failure, not a reason to search for a weaker one.
        actor = comment.get('user') or {}
        need(actor.get('login') == owner_login and actor.get('id') == owner_id, 'untrusted grant actor')
        need(comment.get('author_association') == 'OWNER', 'grant author association not OWNER')
        need(comment.get('created_at') == comment.get('updated_at'), 'edited grant comment')
        need(isinstance(comment.get('id'), int), 'missing authenticated comment ID')
        try:
            grant = json.loads(body[len(GRANT_PREFIX):])
        except ValueError as exc:
            raise GuardError('invalid grant JSON') from exc
        need(isinstance(grant, dict) and set(grant) == GRANT_KEYS, 'grant schema wrong')
        need(grant['version'] == 1 and type(grant['repo_id']) is int and grant['repo_id'] == repo_id, 'grant repository/version mismatch')
        need(type(grant['pr']) is int and grant['pr'] == context['pr'], 'grant PR mismatch')
        for k in ('head', 'base', 'branch', 'work_item'):
            need(grant[k] == context[k], f'grant {k} mismatch')
        need(grant['kind'] == kind, 'grant kind mismatch')
        created, expiry = utc(comment['created_at']), utc(grant['expires_at'])
        need(created <= now <= expiry, 'expired or premature grant')
        need(dt.timedelta() < expiry - created <= dt.timedelta(hours=24), 'grant TTL exceeds 24 hours')
        valid.append(comment['id'])
    need(len(valid) == 1, 'requires exactly one authenticated unexpired grant')
    return valid[0]

def git(*args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    result = subprocess.run(['git', *args], env=env, capture_output=True, text=True, timeout=20, check=False)
    need(result.returncode == 0, 'git read failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()

def inspect_local_git(ctx, packet, approved_ref='refs/rosuno/approved'):
    need(git('rev-parse', '--verify', 'HEAD^{commit}') != '', 'invalid local HEAD')
    need(git('rev-parse', '--verify', f"{ctx['head']}^{{commit}}") == ctx['head'], 'head not fetched')
    need(git('rev-parse', '--verify', f"{ctx['base']}^{{commit}}") == ctx['base'], 'base not fetched')
    need(git('rev-parse', '--verify', f"{approved_ref}^{{commit}}") == ctx['head'], 'approved owner ref not current exact head')
    content = git('show', f"{ctx['head']}:docs/work-items/{ctx['work_item']}/PACKET.md")
    fields = packet_fields(content)
    for k, expected in [('WORK_ITEM', ctx['work_item']), ('BRANCH', ctx['branch']), ('BASE_SHA', ctx['base'])]:
        need(fields[k] == expected, 'Packet ' + k + ' mismatch')
    need(fields['TYPE'] == 'PROCESS', 'owner automation permits PROCESS only; closure requires separately defined policy')
    need(fields['MIGRATIONS'] == 'none', 'PROCESS guard refuses DB migrations')
    # Trusted default-branch shell guard separately verifies every commit and immutable Packet.
    return fields

def main(argv=None):
    p = argparse.ArgumentParser(description='Read-only owner PROCESS guard; no status or mutation')
    p.add_argument('--event', required=True)
    p.add_argument('--open-prs', required=True)
    p.add_argument('--comments', required=True)
    p.add_argument('--owner-repo', default='NatthanPrevot/Rosuno')
    p.add_argument('--owner-repo-id', type=int, default=1349842353)
    p.add_argument('--owner-login', default='NatthanPrevot')
    p.add_argument('--owner-id', type=int, required=True)
    p.add_argument('--enabled', action='store_true', help='only from separately commissioned trusted runner')
    p.add_argument('--now', help='UTC test fixture only; no production use')
    a = p.parse_args(argv)
    need(a.enabled, 'owner PROCESS automation not enabled; commissioning HOLD')
    need(not a.now or os.environ.get('ROSUNO_TEST_FIXTURE') == '1', 'clock override forbidden')
    now = utc(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    event = json.loads(Path(a.event).read_text(encoding='utf-8'))
    prs = json.loads(Path(a.open_prs).read_text(encoding='utf-8'))
    comments = json.loads(Path(a.comments).read_text(encoding='utf-8'))
    ctx = inspect_event(event, prs, a.owner_repo, a.owner_repo_id, a.owner_login, a.owner_id)
    inspect_grants(comments, ctx, a.owner_repo_id, a.owner_login, a.owner_id, 'PROCESS', now)
    inspect_local_git(ctx, None)
    print(f"ROSUNO-PROCESS-GUARD PASS pr={ctx['pr']} head={ctx['head']} (technical only; CI/Backup separate)")
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (GuardError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print('::error::ROSUNO-PROCESS-GUARD HOLD: ' + str(error), file=sys.stderr)
        sys.exit(1)
