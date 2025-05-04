import React from 'react';
import styles from './style.module.css';

const BrowserWindow = () => {
  return (
    <div className={styles['browser-window']}>
      <div className={styles['browser-header']}>
        <span className={`${styles.dot} ${styles.red}`}></span>
        <span className={`${styles.dot} ${styles.yellow}`}></span>
        <span className={`${styles.dot} ${styles.green}`}></span>
        <span className={styles['browser-url']}>https://app.classmoji.io</span>
      </div>
      <img src='/img/your-screenshot.png' alt='Classmoji student dashboard' />
    </div>
  );
};

export default BrowserWindow;
