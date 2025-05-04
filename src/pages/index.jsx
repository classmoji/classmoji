import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

import Heading from '@theme/Heading';
import styles from './index.module.css';

const HomepageHeader = () => {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className='container'>
        <Heading as='h1' className='hero__title'>
          {siteConfig.title}
        </Heading>
        <p className='hero__subtitle'>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className='button button--secondary button--lg'
            to='/docs/intro'
          >
            Get Started
          </Link>
        </div>
      </div>
    </header>
  );
};

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
      {/* <div className='mx-auto max-w-[800px] flex flex-col items-center pt-[10vh]'>
        <p className='text-center text-3xl leading-relaxed'>
          Classmoji is built on the belief that grading should be meaningful,
          not mechanical. Instead of rigid points and deadlines, we use emojis,
          tokens, and flexible workflows to foster feedback, autonomy, and
          iteration. By integrating directly with GitHub, Classmoji lets
          instructors focus on what matters: helping students grow—not managing
          spreadsheets.
        </p>
      </div> */}
    </Layout>
  );
};

export default Home;
