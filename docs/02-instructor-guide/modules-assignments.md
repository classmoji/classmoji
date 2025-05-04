---
title: Modules & Assignments
sidebar_label: 🧱 Modules & Assignments
sidebar_position: 2
---

# 🧱 Creating Modules & Assignments

In Classmoji, each **module** is a GitHub repository created for a student (or team), and each **assignment** is a GitHub issue within that repo.

This structure mirrors real-world development workflows while enabling flexible grading, feedback, and versioning.

## 📦 What Is a Module?

A **module** represents a unit of coursework (like a lab or project). When you publish a module:

- A GitHub **repository** is created for each student or team
- One or more **issues** (assignments) are created inside that repository
- Students complete assignments by pushing code and **closing issues**

## 🧰 Creating a Module

To create a module, you'll define:

- **Title** – the name of the module (e.g., `Project 1`)
- **Type** – `Individual` or `Team`
- **Weight** – how much this module contributes to the final grade
- **Extra Credit?** – mark if this is optional bonus work
- **Create Feedback Branch?** – optionally create a branch for TA/instructor comments
- **Template Repository** – the starting code (structure, files, branches) used to generate student repos

:::tip
📁 **Student repo naming format**: `moduleName_studentGithubUsername` (e.g., `project1_adaLovelace`)
:::

## 📝 Adding Assignments to a Module

Each assignment is a GitHub **issue** that lives inside the module repository. You can add multiple assignments per module.

### Properties

- **Title** – the issue title (e.g., “Build the API endpoints”)
- **Branch** – the target branch for submission (e.g., `part1`, `part2`)
- **Workflow File** – name of the GitHub Actions file for auto-grading (must exist in the template repo)
- **Weight** – % contribution to the module grade
- **Student Deadline** – when students must close the issue
- **Grader Deadline** – when TAs should finish grading
- **Tokens per Hour** – cost for late submission extensions
- **Description** – full instructions shown to the student in the GitHub issue

:::info
Assignments are only created if a **student deadline** is set. This allows you to release them gradually.
:::

## 🚀 Publishing a Module

Publishing a module triggers Classmoji to:

- Create a repository for each student or team
- Add students and TAs to the repo
- Create issues (assignments) as defined

:::warning
**Template Repos Cannot Be Changed** after publishing. Choose carefully before publishing!
:::

## 🔄 Syncing a Module

Use the **Sync Module** feature to:

- Create repos and issues for students who joined late
- Add newly released assignments to existing repos

## 🗑️ Deleting a Module

Deleting a module in Classmoji removes it from your dashboard, but **does not delete** associated GitHub repositories or issues.

## ✅ Best Practices

- Use branches for different parts of multi-stage assignments
- Include auto-grading workflows in your template repo
- Keep issue instructions concise and formatted (markdown supported)
- Set student deadlines first, then stagger grader deadlines after
