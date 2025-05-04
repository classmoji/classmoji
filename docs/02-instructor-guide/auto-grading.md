---
title: Auto-grading
sidebar_label: 🤖 Auto-grading
sidebar_position: 3
---

# 🤖 Auto-Grading with GitHub Actions

Classmoji supports automated grading by running tests inside each student's repository using **GitHub Actions**.

When students push their code to the assigned branch, a GitHub workflow is triggered. This workflow runs your tests and generates a score based on the results.

## 🛠️ How It Works

1. You include a test suite and a workflow file in your **template repository**.
2. Classmoji copies this repo to create each student's assignment repository.
3. On each push to the specified branch, the GitHub Action runs and computes a grade.
4. The grade is recorded and shown in the Classmoji instructor dashboard.

:::info
You are responsible for writing your own tests and workflows. We provide examples in our template repo to help you get started.
:::

## 🧾 Example: Node.js + Jest Auto-Grading Workflow

Here's an example GitHub Actions workflow (`.github/workflows/grade.yml`) for a Node.js assignment that uses **Jest** to run tests:

```yaml
name: Run Tests
on:
  push:
    branches:
      - main
  workflow_dispatch:

jobs:
  run-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run Jest tests
        run: npx jest sum.test.js
        continue-on-error: true

      - name: Read CTRF report
        id: read_report
        uses: brunchlabs/read-test-report-action@main

      - name: Run autograder
        uses: brunchlabs/run-autograder-action@main
        with:
          report: ${{ steps.read_report.outputs.content }}
```

## 📕 Key Concepts

- **Workflow File Name**: When you create an assignment in Classmoji, you specify the name of the workflow file (e.g., `grade.yml`).
- **Branch Trigger**: The workflow will only run on the branch specified in the assignment.

## 🧩 Report Format: CTRF

Classmoji uses a unified test report format called **CTRF** (Classmoji Test Result Format) to interpret student test results, regardless of what language or framework you're using.

### What is CTRF?

CTRF is a JSON-based test report format created to unify the structure of test result reports across various tools and frameworks.

- Ensures consistent report format across different testing tools
- Compatible with any programming language and testing framework
- Facilitates easy integration and analysis through a standardized structure

## 🔧 How to Generate a CTRF Report

The CTRF format is an open-source initiative that provides reporters for a variety of widely used testing frameworks. These include popular tools such as Jest, Cypress, Mocha, Selenium, JUnit, and many others. This open-source approach ensures that you can generate CTRF reports across different languages and frameworks, facilitating seamless integration with GitHub Actions for automated grading.

## 🔧 Supported Languages

You can use any language that works with GitHub Actions. We provide example workflows for:

- Node.js (Jest, Mocha)
- Python (pytest)
- Java (JUnit)
- C++ (Google Test)

## ✅ Best Practices

- Keep tests scoped and fast
- Use `continue-on-error: true` to ensure all steps complete
- Always commit your workflow and test files to the template repo before publishing a module
- Use unique branch names per assignment (e.g., `part1`, `lab2`) to isolate auto-grading logic

Next: Learn how tokens and late penalties work in [Deadlines & Tokens](./deadlines-tokens.md)
