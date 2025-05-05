import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

import Heading from '@theme/Heading';
import styles from './index.module.css';

export const Home = () => {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`Hello from ${siteConfig.title}`}
      description='Description will go into a meta tag in <head />'
    >
      <div className={clsx('hero hero--primary', styles.heroBanner)}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100vw',
            height: '100vh',
          }}
        >
          <div style={{ fontSize: '4.5rem', fontWeight: 'bold' }}>
            classm😅ji
          </div>
          <p style={{ fontSize: '2.5rem', fontWeight: '600' }}>
            {siteConfig.tagline}
          </p>
          <p
            style={{
              fontSize: '1.5rem',
              maxWidth: '32rem',
              textAlign: 'center',
              lineHeight: '1.75',
            }}
          >
            A creative and best-practices-based learning management platform for
            GitHub-based projects and grades.
          </p>
          <div className={styles.buttons}>
            <Link
              className='button button--secondary button--lg'
              to='/docs/intro'
            >
              Get Started
            </Link>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <p style={{ fontSize: '1.025rem', marginTop: '20px' }}>
          © 2025 Classmoji · Made with 🤝 by the{' '}
          <a href='https://dali.dartmouth.edu'>DALI Lab</a> and{' '}
          <a href='https://cs.dartmouth.edu'>CS Department</a> at Dartmouth
          College
        </p>
      </div>
    </Layout>
  );
};

export default Home;
