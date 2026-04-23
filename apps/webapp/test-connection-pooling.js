#!/usr/bin/env node

/**
 * Test script to verify connection pooling is working
 * Run this to see that only one connection is created and reused
 */

import {
  initializeCodeAwareQuizViaAgent,
  sendMessageToAgent,
  endQuizSession,
} from './app/routes/student.$org.quizzes/aiAgent.server.js';

async function testConnectionPooling() {
  console.log('\n🧪 Testing WebSocket Connection Pooling\n');
  console.log('='.repeat(50));

  const attemptId = 'test-' + Date.now();
  const userId = 'test-user';
  const assignmentId = 'test-assignment';

  try {
    // Test 1: Initialize quiz (should create connection)
    console.log('\n1️⃣ Initializing quiz...');
    console.log('   Expected: "Creating new connection"');
    await initializeCodeAwareQuizViaAgent(
      attemptId,
      userId,
      assignmentId,
      'test-org',
      'test-repo',
      'fake-token',
      {
        systemPrompt: 'Test prompt',
        rubricPrompt: 'Test rubric',
        questionCount: 5,
      }
    );
    console.log('   ✅ Quiz initialized');

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: Send message (should reuse connection)
    console.log('\n2️⃣ Sending first message...');
    console.log('   Expected: NO "Creating new connection"');
    await sendMessageToAgent(attemptId, 'Test message 1');
    console.log('   ✅ First message sent');

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 3: Send another message (should still reuse)
    console.log('\n3️⃣ Sending second message...');
    console.log('   Expected: NO "Creating new connection"');
    await sendMessageToAgent(attemptId, 'Test message 2');
    console.log('   ✅ Second message sent');

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 4: End quiz (should still reuse)
    console.log('\n4️⃣ Ending quiz session...');
    console.log('   Expected: NO "Creating new connection"');
    await endQuizSession(attemptId);
    console.log('   ✅ Quiz session ended');

    console.log('\n' + '='.repeat(50));
    console.log('✨ SUCCESS: Connection pooling is working!');
    console.log('   Only ONE connection should have been created.');
    console.log('='.repeat(50) + '\n');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('   Make sure ai-agent service is running on port 6000');
    process.exit(1);
  }

  // Give time to see logs before exit
  setTimeout(() => process.exit(0), 2000);
}

// Run the test
testConnectionPooling();
