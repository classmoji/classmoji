import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import VideoPlayer from '@site/src/components/VideoPlayer';
import styles from './index.module.css';
import thumbnail from '@site/static/img/thumbnail.png';

const FeatureList = [
  {
    title: 'GitHub Integration',
    description:
      'Seamlessly, manage GitHub repositories for project-based learning, automated grading workflows, and pull request review style feedback.',
    icon: '🔗',
  },
  {
    title: 'Emoji Feedback*',
    description:
      'Classmoji promotes clear emoji feedback (🔥👍👀👎) backed by actionable comments.',
    icon: '🔥',
  },
  {
    title: 'Soft Late Penalties',
    description:
      'Soft late penalties reduce panic and encourage honest submissions by keeping deadlines meaningful while allowing students to buy back deductions with earned tokens.',
    icon: '⏳',
  },
  {
    title: 'Gamified Extra Credit',
    description:
      'Gamified extra credit lets students earn tokens to buy back late penalties or offset quiz grades, turning extra effort into tangible rewards and pathways to 🔥-level mastery.',
    icon: '🎮',
  },
  {
    title: 'TA Load Balancing',
    description:
      'TA load balancing uses leaderboards, tracking, and auto-assignment to keep grading fair, enable collaboration, and maintain momentum toward deadlines.',
    icon: '🧑‍🤝‍🧑',
  },
  {
    title: '(Coming Soon) AI Interactive Quizzes',
    description:
      'Coming soon: AI interactive quizzes that deliver adaptive, oral-exam–style questioning to reduce plagiarism, verify understanding, and build communication skills at scale.',
    icon: '🤖',
  },
];

function Feature({ title, description, icon }) {
  return (
    <div className={clsx('col col--4')}>
      <div className='text--center padding-horiz--md'>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>{icon}</div>
        <Heading
          as='h3'
          style={{ fontSize: '1.3rem', marginBottom: '0.75rem' }}
        >
          {title}
        </Heading>
        <p
          style={{
            fontSize: '1rem',
            lineHeight: '1.6',
            color: 'var(--ifm-color-emphasis-700)',
          }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}

export const Home = () => {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout
      title={`${siteConfig.title} - GitHub-based Learning Management`}
      description='A creative and best-practices-based learning management platform for GitHub-based projects and grades.'
    >
      {/* Hero Section */}
      <header
        className={clsx('hero hero--primary', styles.heroBanner)}
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div className='container' style={{ zIndex: 2 }}>
          <div className='row' style={{ position: 'relative', top: '-1.5rem' }}>
            <div className='col col--12 text--center'>
              <div
                style={{
                  fontSize: 'clamp(3rem, 8vw, 5rem)',
                  fontWeight: '800',
                  color: 'white',
                }}
              >
                classm
                <span
                  style={{
                    paddingLeft: '0.1em',
                    paddingRight: '0.05em',
                  }}
                >
                  🎯
                </span>
                ji
              </div>

              <p
                style={{
                  fontSize: 'clamp(1.1rem, 2.5vw, 1.4rem)',
                  maxWidth: '42rem',
                  margin: '0 auto 2rem',
                  lineHeight: '1.7',
                  color: 'white',
                  fontWeight: '400',
                }}
              >
                A creative and best-practices-based learning management platform
                for GitHub-based projects and grades.
              </p>

              {/* Demo Video */}
              <div
                style={{
                  maxWidth: '1000px',
                  margin: '0 auto 1.5rem',
                  borderRadius: '16px',
                  overflow: 'hidden',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
                  background:
                    'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))',
                  padding: '6px',
                }}
              >
                <VideoPlayer
                  src='/videos/quick_demo.mp4'
                  thumbnail={thumbnail}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Link
                  className='button button--secondary button--lg'
                  to='/docs/intro'
                  style={{
                    borderRadius: '8px',
                    fontWeight: '500',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    transition: 'all 0.3s ease',
                  }}
                >
                  Get Started 🚀
                </Link>
                <Link
                  className='button button--outline button--lg'
                  to='/docs/intro'
                  style={{
                    borderRadius: '8px',
                    fontWeight: '500',
                    color: 'white',
                    borderColor: 'white',
                    transition: 'all 0.3s ease',
                  }}
                >
                  Learn More
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* Animated background bubbles */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            opacity: 0.1,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '20%',
              left: '10%',
              width: '100px',
              height: '100px',
              background: 'white',
              borderRadius: '50%',
              animation: 'float 6s ease-in-out infinite',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '60%',
              right: '15%',
              width: '80px',
              height: '80px',
              background: 'white',
              borderRadius: '50%',
              animation: 'float 4s ease-in-out infinite reverse',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '40%',
              left: '70%',
              width: '60px',
              height: '60px',
              background: 'white',
              borderRadius: '50%',
              animation: 'float 5s ease-in-out infinite',
            }}
          />
        </div>
      </header>

      {/* Features Section */}
      <main>
        <section
          style={{
            padding: '4rem 0',
            background: 'var(--ifm-background-color)',
          }}
        >
          <div className='container'>
            <div className='text--center margin-bottom--lg'>
              <Heading
                as='h2'
                style={{
                  fontSize: 'clamp(1.8rem, 4vw, 2.5rem)',

                  color: 'var(--ifm-color-primary)',
                }}
              >
                Why Choose Classmoji?
              </Heading>
              <p
                style={{
                  fontSize: '1.1rem',
                  color: 'var(--ifm-color-emphasis-700)',
                  maxWidth: '600px',
                  margin: '0 auto',
                }}
              >
                Built for modern education with GitHub at its core
              </p>
            </div>
            <div className='row'>
              {FeatureList.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
            <p
              className='text--center'
              style={{
                marginTop: '1rem',
                fontSize: '0.95rem',
                color: 'var(--ifm-color-emphasis-700)',
              }}
            >
              <em>
                * Learn more about the pedagogy behind these features{' '}
                <Link to='/blog/welcome'>on our blog</Link>.
              </em>
            </p>
          </div>
        </section>

        {/* CTA Section */}
        <section
          style={{
            padding: '4rem 0',
            background: 'var(--ifm-color-emphasis-100)',
          }}
        >
          <div className='container'>
            <div className='row'>
              <div className='col col--8 col--offset-2 text--center'>
                <Heading
                  as='h2'
                  style={{ fontSize: '2rem', marginBottom: '1rem' }}
                >
                  Ready to Transform Your Classroom?
                </Heading>
                <p
                  style={{
                    fontSize: '1.1rem',
                    marginBottom: '1.5rem',
                    color: 'var(--ifm-color-emphasis-700)',
                  }}
                >
                  Join educators who are already using Classmoji to create
                  engaging, project-based learning experiences.
                </p>
                <Link
                  className='button button--primary button--lg'
                  to='/docs/intro'
                  style={{
                    borderRadius: '8px',
                    fontWeight: '500',
                  }}
                >
                  Start Your Journey
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <style jsx>{`
        @keyframes float {
          0%,
          100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-20px);
          }
        }
      `}</style>
    </Layout>
  );
};

export default Home;
