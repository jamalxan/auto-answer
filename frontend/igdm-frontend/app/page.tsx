import SmoothScroll from "@/components/motion/SmoothScroll";
import Hero from "@/components/landing/Hero";
import Descent from "@/components/landing/Descent";
import Kommutator from "@/components/landing/Kommutator";
import Swarm from "@/components/landing/Swarm";
import LandingAct from "@/components/landing/Landing";

/**
 * The page is a film in five acts. One motion idea per act,
 * exactly one pin (ACT 3), and the accent colour appears only on the
 * focal point of each viewport.
 */
export default function Page() {
  return (
    <main>
      <SmoothScroll />
      <Hero />
      <Descent />
      <Kommutator />
      <Swarm />
      <LandingAct />
    </main>
  );
}
