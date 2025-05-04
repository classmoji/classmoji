---
title: Submissions
sidebar_label: Submissions
sidebar_position: 5
---

# 📤 Submitting Assignments

In Classmoji, students submit their work using **GitHub issues and branches**, following the same workflows used in professional software development.

This guide explains how submission works and what instructors need to configure.

## 📝 Assignment Format

Each assignment in Classmoji is created as a **GitHub issue** inside a student's (or team’s) module repository.

- Students complete the work on a specified **branch**
- Once they're done, they **close the issue** to signal submission
- Classmoji uses the issue closure timestamp to determine if the work was submitted on time

## 🔀 Working on the Correct Branch

When creating an assignment, instructors define a **target branch** for submission (e.g., `part1`, `lab2`).

Students should:

1. Check out the specified branch
2. Commit and push their work to that branch
3. Ensure the branch contains all files needed for grading

:::tip
Students should never submit work to `main` unless explicitly told to do so.
:::

## ✅ Submitting via GitHub Issue

Once a student completes their work:

1. Navigate to the assignment issue in their repository
2. Confirm they’ve pushed the latest code
3. Click **“Close issue”** in GitHub to mark it as submitted

Classmoji will:

- Record the submission time
- Trigger auto-grading (if configured)
- Track lateness and token use

## 🕓 What If the Issue is Reopened?

If a student reopens an issue and closes it again, only the **most recent closure time** is used to determine lateness. Repeated closures will **not** overwrite previous grades unless resubmissions are enabled.

## 🧠 Instructor Controls

- You can configure resubmissions and feedback workflows per assignment
- Submissions are only accepted on or after issue creation
- You can review timestamps, submission branches, and token usage from the dashboard
