#!/bin/sh
# Rebuilds the local test database from the migrations and the question import.
set -e
P="psql -h /var/tmp/pgtest -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
cd "$(dirname "$0")/.."
$P -c 'drop database if exists spintest' -c 'create database spintest'
$P -d spintest -f tests/local-bootstrap.sql
for f in supabase/migrations/*.sql; do $P -d spintest -f "$f"; done
$P -d spintest -f supabase/questions-import.sql
