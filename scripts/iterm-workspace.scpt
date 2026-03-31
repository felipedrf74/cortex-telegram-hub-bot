#!/usr/bin/env osascript

-- Nexus Hub — iTerm2 Workspace Setup
-- Creates: Tab 1 (4 agent panes) | Tab 2 (git/review) | Tab 3 (deploy) | Tab 4 (misc)

tell application "iTerm2"
  activate
  
  -- Create a new window
  set newWindow to (create window with default profile)
  
  tell current session of current tab of newWindow
    -- TAB 1, Pane 1: Agent - AIProvider
    write text "cd ~/Desktop/Custom\\ Connectors/Cortex/nexushub-worktrees/feature-aiprovider && echo '🤖 Agent 1: AIProvider' && pwd"
    
    -- Split right: Pane 2
    set pane2 to (split vertically with default profile)
    tell pane2
      write text "cd ~/Desktop/Custom\\ Connectors/Cortex/nexushub-worktrees/feature-message-adapter && echo '🤖 Agent 2: Message Adapter' && pwd"
    end tell
  end tell
  
  -- Split Pane 1 horizontally: Pane 3
  tell first session of current tab of newWindow
    set pane3 to (split horizontally with default profile)
    tell pane3
      write text "cd ~/Desktop/Custom\\ Connectors/Cortex/nexushub-worktrees/feature-test-expansion && echo '🧪 Agent 3: Test Expansion' && pwd"
    end tell
  end tell
  
  -- Split Pane 2 horizontally: Pane 4
  tell second session of current tab of newWindow
    set pane4 to (split horizontally with default profile)
    tell pane4
      write text "cd ~/Desktop/Custom\\ Connectors/Cortex/nexushub-worktrees/bugfix-agent && echo '🐛 Agent 4: Bug Agent' && pwd"
    end tell
  end tell
  
  -- TAB 2: Git & Review
  tell newWindow
    set tab2 to (create tab with default profile)
    tell current session of tab2
      write text "cd ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot && echo '📦 Git & Review — Main Repo' && git status"
    end tell
  end tell
  
  -- TAB 3: Deploy & Server
  tell newWindow
    set tab3 to (create tab with default profile)
    tell current session of tab3
      write text "cd ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot && echo '🚀 Deploy & Server' && echo 'Run: nexus-deploy'"
    end tell
  end tell
  
  -- TAB 4: Monitoring & Misc
  tell newWindow
    set tab4 to (create tab with default profile)
    tell current session of tab4
      write text "cd ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot && echo '📊 Monitoring & Misc' && echo 'Run: ./scripts/agent-status.sh'"
    end tell
  end tell
  
  -- Go back to Tab 1 (agents)
  tell newWindow
    select first tab
  end tell
  
end tell
