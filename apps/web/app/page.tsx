import Link from 'next/link';
import { CATEGORIES_PHASE1 } from "../lib/categories";
import Phase1Categories from "../components/Phase1Categories";
import '../styles/phase1-categories.css';

export const metadata = {
  alternates: { canonical: '/' },
};

const testimonials = [
  {
    quote: "Found the perfect DJ for our wedding. The process was smooth and the music was exactly what we wanted.",
    name: "Wedding Couple",
    location: "Mumbai",
    avatar: "/assets/artist-singer.png",
    alt: "Happy couple at their wedding celebration"
  },
  {
    quote: "Professional service from start to finish. The artist arrived on time and made our corporate event a huge success.",
    name: "Event Manager",
    location: "Mumbai",
    avatar: "/assets/artist-photographer.jpg",
    alt: "Corporate event setup with professional lighting"
  }
];

const howItWorks = [
  { step: '1', title: 'Request', desc: 'Share your event details, venue, and requirements. We\'ll match you with the perfect talent.' },
  { step: '2', title: 'Get Matched', desc: 'Our team confirms availability and finalizes the lineup for your event.' },
  { step: '3', title: 'Execute & Enjoy', desc: 'Professional artists deliver an amazing experience. Secure payments and quality guaranteed.' },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-grid">
          <div>
            <div className="hero-eyebrow">
              <span className="pill-badge">Mumbai Events</span>
              <span className="muted-sub">Professional • Verified • Reliable</span>
            </div>
            <h1>Mumbai events, executed reliably.</h1>
            <p>Weddings, celebrations, and corporate events — curated talent + professional crews. Quality artists, seamless coordination, memorable experiences.</p>
            <div className="cta-row">
              <Link className="button-primary" href="/book?tab=brief">Request a Curated Booking</Link>
              <Link className="button-secondary" href="/register">Join as Artist/Vendor</Link>
            </div>
            <div className="trust-strip hero-badges">
              <span>Families & societies</span>
              <span>Wedding functions</span>
              <span>Corporate events</span>
              <span>Backup‑ready support</span>
            </div>
          </div>
          <div className="hero-media hero-collage">
            <div className="hero-collage__bg" aria-hidden />
            <div className="hero-collage__grid">
              <div className="hero-collage__card hero-collage__card--main">
                <img src="/assets/hero-artist.jpg" alt="Professional artist performing at Mumbai event" width={1200} height={800} />
              </div>
              <div className="hero-collage__card hero-collage__card--top">
                <img src="/assets/artist-dj.jpg" alt="DJ performing at an event" width={900} height={700} />
              </div>
              <div className="hero-collage__card hero-collage__card--bottom">
                <img src="/assets/artist-dancer.jpg" alt="Dance group performance energy for events" width={900} height={700} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="container">
        <h2 className="section-heading">Popular stacks</h2>
        <p className="section-sub">Fast, reliable building blocks for weddings, family celebrations, and corporate events.</p>
        <div className="stack-grid">
          <Link href="/book?tab=brief" className="stack-card">
            <img src="/assets/sangeet.png" alt="Sangeet night performance" width={1200} height={800} />
            <div className="stack-card__body">
              <strong>Sangeet Night</strong>
              <div className="muted-sub">DJ • Sound • Light • Emcee • Choreo</div>
            </div>
          </Link>
          <Link href="/book?tab=brief" className="stack-card">
            <img src="/assets/society.png" alt="Home society celebration" width={1200} height={800} />
            <div className="stack-card__body">
              <strong>Home / Society Party</strong>
              <div className="muted-sub">DJ • Sound • Light • Emcee</div>
            </div>
          </Link>
          <Link href="/book?tab=brief" className="stack-card">
            <img src="/assets/corporate.png" alt="Corporate evening event" width={1200} height={800} />
            <div className="stack-card__body">
              <strong>Corporate Evening</strong>
              <div className="muted-sub">Singer • DJ • Sound • Light</div>
            </div>
          </Link>
        </div>
      </section>

      <section className="container">
        <h2 className="section-heading">Popular Categories</h2>
        <p className="section-sub">Top creators across music, hosting, and production — curated for reliable execution.</p>
        <div className="category-grid">
          {CATEGORIES_PHASE1.slice(0, 7).map((category: any) => (
            <Link key={category.key} href={`/book?tab=brief&category=${category.key}`} className="category-card">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="neon-icon" style={{ WebkitMaskImage: `url(${category.iconPath})`, maskImage: `url(${category.iconPath})` }}></span>
                <div>
                  <strong>{category.title}</strong>
                  <span className="muted-sub">{category.blurb}</span>
                  {category.priceRange && <div className="price-display">{category.priceRange}</div>}
                </div>
              </div>
              <span className="category-pill">
                <strong>Request with KalaQaar</strong>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* Categories Section */}
      <Phase1Categories />

      <section className="container">
        <h2 className="section-heading">How It Works</h2>
        <p className="section-sub">Concierge-led booking with escrow so clients feel protected and artists get paid on time.</p>
        <div className="how-grid">
          {howItWorks.map((item) => (
            <div key={item.step} className="how-card">
              <div className="how-step">{item.step}</div>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container">
        <h2>Why people choose KalaQaar</h2>
        <div className="testimonials-grid">
          {testimonials.map((testimonial, index) => (
            <div key={index} className="testimonial-card">
              <img src={testimonial.avatar} alt={testimonial.alt} />
              <blockquote>"{testimonial.quote}"</blockquote>
              <cite>
                <strong>{testimonial.name}</strong>
                <span className="muted-sub">{testimonial.location}</span>
              </cite>
            </div>
          ))}
        </div>
      </section>

      <section className="container">
        <h2>Ready to Get Started?</h2>
        <div className="cta-row">
          <Link className="button-primary" href="/book?tab=brief">Request a Curated Booking</Link>
          <Link className="button-secondary" href="/register">Join as Artist/Vendor</Link>
        </div>
      </section>
    </>
  );
}
