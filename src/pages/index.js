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
        <div className='flex flex-col items-center justify-center w-screen h-screen gap-4'>
          <div className='text-7xl font-bold'>classm😅ji</div>
          <p className=' text-4xl font-semibold'>{siteConfig.tagline}</p>
          <p className='text-2xl  max-w-2xl text-center leading-relaxed'>
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
