interface Props {
  children: React.ReactNode;
}

export default function SiteFooter({ children }: Props) {
  return (
    <footer className="mt-8 text-center font-mono text-xs text-[#7d8590]">
      <p>{children}</p>
      <p className="mt-1">
        built by{" "}
        <a href="https://hendragunawan.com" target="_blank" rel="noopener noreferrer" className="text-[#58a6ff] hover:underline">
          Hendra Gunawan
        </a>
      </p>
    </footer>
  );
}
