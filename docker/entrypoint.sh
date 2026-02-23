#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Klaus-Code Docker Entrypoint
# Sets up git credentials if provided, then starts the agent
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ── Git Credentials Setup ────────────────────────────────────────────────────
# If GIT_CREDENTIALS is provided, configure git to use it for HTTPS auth.
# Format: https://username:token@github.com (or gitlab.com, etc.)
#
# This uses git's credential helper to provide the token when git needs auth.
# The token is stored in memory only, not written to disk.

if [ -n "$GIT_CREDENTIALS" ]; then
  echo "Configuring git credentials..."
  
  # Extract the host from the credentials URL (e.g., github.com)
  GIT_HOST=$(echo "$GIT_CREDENTIALS" | sed -n 's|https://[^@]*@\([^/]*\).*|\1|p')
  
  if [ -n "$GIT_HOST" ]; then
    # Configure git to use the credential helper for this host
    git config --global credential.helper 'store --file=/tmp/.git-credentials'
    
    # Write credentials to temporary file (in-memory tmpfs in Docker)
    echo "$GIT_CREDENTIALS" > /tmp/.git-credentials
    chmod 600 /tmp/.git-credentials
    
    # Set default identity if not already configured
    git config --global user.email "${GIT_USER_EMAIL:-klaus-code@localhost}"
    git config --global user.name "${GIT_USER_NAME:-Klaus-Code Agent}"
    
    echo "Git credentials configured for $GIT_HOST"
  else
    echo "Warning: GIT_CREDENTIALS format invalid. Expected: https://user:token@host.com"
  fi
fi

# ── Execute the main command ─────────────────────────────────────────────────
exec "$@"
