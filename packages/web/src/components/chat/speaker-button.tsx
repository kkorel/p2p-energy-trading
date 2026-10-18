'use client';

import { memo, useState, useEffect } from 'react';
import { Volume2, VolumeX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAudioPlayer, type Speaker } from '@/hooks/use-audio-player';

/**
 * Props for the SpeakerButton component
 */
export interface SpeakerButtonProps {
  /** Text to speak */
  text: string;
  /** Language code (e.g., 'hi-IN', 'en-IN') */
  languageCode: string;
  /** Voice speaker */
  speaker?: Speaker;
  /** Speech pace (0.3 - 3.0) */
  pace?: number;
  /** Button size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS classes */
  className?: string;
  /** Whether the button is disabled */
  disabled?: boolean;
}

/**
 * Sound wave animation bars
 */
function SoundWaves({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="w-0.5 bg-current rounded-full animate-sound-wave"
          style={{
            animationDelay: `${i * 0.1}s`,
            height: '100%',
          }}
        />
      ))}
    </div>
  );
}

/**
 * Premium speaker button for text-to-speech playback.
 * 
 * Features:
 * - Animated sound waves when playing
 * - Loading spinner when fetching audio
 * - Smooth state transitions
 * - Caches audio for instant replay
 */
export const SpeakerButton = memo(function SpeakerButton({
  text,
  languageCode,
  speaker = 'anushka',
  pace = 1.0,
  size = 'md',
  className,
  disabled = false,
}: SpeakerButtonProps) {
  const [isClient, setIsClient] = useState(false);
  
  const {
    state,
    isPlaying,
    isLoading,
    hasError,
    currentText,
    toggle,
    stop,
  } = useAudioPlayer({
    defaultSpeaker: speaker,
    defaultPace: pace,
  });

  // Hydration fix - only render interactive content on client
  useEffect(() => {
    setIsClient(true);
  }, []);

  const isThisPlaying = isPlaying && currentText === text;
  const isThisLoading = isLoading && currentText === text;

  const handleClick = async () => {
    if (disabled || !isClient) return;
    
    if (isThisPlaying) {
      stop();
    } else {
      await toggle(text, languageCode, speaker, pace);
    }
  };

  // Size classes
  const sizeClasses = {
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-11 h-11',
  };

  const iconSizes = {
    sm: 14,
    md: 18,
    lg: 22,
  };

  // Don't render interactive state during SSR
  if (!isClient) {
    return (
      <button
        className={cn(
          sizeClasses[size],
          'flex items-center justify-center rounded-full transition-all duration-200',
          'bg-[var(--color-surface)] text-[var(--color-text-secondary)]',
          'hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)]',
          disabled && 'opacity-40 cursor-not-allowed',
          className
        )}
        disabled={disabled}
        aria-label="Listen to message"
        title="Listen to message"
        type="button"
      >
        <Volume2 size={iconSizes[size]} />
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isLoading}
      className={cn(
        sizeClasses[size],
        'relative flex items-center justify-center rounded-full transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2',
        
        // Idle state
        !isThisPlaying && !isThisLoading && !hasError && [
          'bg-[var(--color-surface)] text-[var(--color-text-secondary)]',
          'hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)]',
          'active:scale-95',
        ],
        
        // Loading state
        isThisLoading && [
          'bg-[var(--color-primary-light)] text-[var(--color-primary)]',
          'cursor-wait',
        ],
        
        // Playing state
        isThisPlaying && [
          'bg-[var(--color-primary)] text-white',
          'hover:bg-[var(--color-primary-dark)]',
          'active:scale-95',
        ],
        
        // Error state
        hasError && currentText === text && [
          'bg-[var(--color-danger-light)] text-[var(--color-danger)]',
          'hover:bg-[var(--color-danger)] hover:text-white',
        ],
        
        disabled && 'opacity-40 cursor-not-allowed',
        className
      )}
      aria-label={isThisPlaying ? 'Stop listening' : isThisLoading ? 'Loading audio...' : 'Listen to message'}
      title={isThisPlaying ? 'Stop' : isThisLoading ? 'Loading...' : 'Listen'}
      type="button"
    >
      {isThisLoading ? (
        <Loader2 size={iconSizes[size]} className="animate-spin" />
      ) : isThisPlaying ? (
        <div className="flex items-center justify-center w-full h-full">
          <SoundWaves className="h-3" />
        </div>
      ) : hasError && currentText === text ? (
        <VolumeX size={iconSizes[size]} />
      ) : (
        <Volume2 size={iconSizes[size]} />
      )}

      {/* Playing indicator ring */}
      {isThisPlaying && (
        <div className="absolute inset-0 rounded-full border-2 border-[var(--color-primary)] animate-ping opacity-25" />
      )}
    </button>
  );
});

/**
 * Inline speaker button that fits next to text
 * Smaller and more subtle than the main SpeakerButton
 */
export const InlineSpeakerButton = memo(function InlineSpeakerButton({
  text,
  languageCode,
  speaker = 'anushka',
  pace = 1.0,
  className,
  disabled = false,
}: Omit<SpeakerButtonProps, 'size'>) {
  const [isClient, setIsClient] = useState(false);
  
  const {
    isPlaying,
    isLoading,
    hasError,
    currentText,
    toggle,
    stop,
  } = useAudioPlayer({
    defaultSpeaker: speaker,
    defaultPace: pace,
  });

  useEffect(() => {
    setIsClient(true);
  }, []);

  const isThisPlaying = isPlaying && currentText === text;
  const isThisLoading = isLoading && currentText === text;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled || !isClient) return;
    
    if (isThisPlaying) {
      stop();
    } else {
      await toggle(text, languageCode, speaker, pace);
    }
  };

  if (!isClient) {
    return (
      <button
        className={cn(
          'inline-flex items-center justify-center w-5 h-5 rounded-full',
          'text-[var(--color-text-muted)] hover:text-[var(--color-primary)]',
          'transition-colors',
          className
        )}
        disabled={disabled}
        aria-label="Listen"
        type="button"
      >
        <Volume2 size={12} />
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isLoading}
      className={cn(
        'inline-flex items-center justify-center w-5 h-5 rounded-full',
        'transition-all duration-150',
        
        !isThisPlaying && !isThisLoading && [
          'text-[var(--color-text-muted)]',
          'hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)]',
        ],
        
        isThisLoading && 'text-[var(--color-primary)]',
        
        isThisPlaying && [
          'text-[var(--color-primary)] bg-[var(--color-primary-light)]',
        ],
        
        hasError && currentText === text && 'text-[var(--color-danger)]',
        
        disabled && 'opacity-40 cursor-not-allowed',
        className
      )}
      aria-label={isThisPlaying ? 'Stop' : 'Listen'}
      title={isThisPlaying ? 'Stop' : 'Listen'}
      type="button"
    >
      {isThisLoading ? (
        <Loader2 size={12} className="animate-spin" />
      ) : isThisPlaying ? (
        <div className="flex items-center gap-px h-2.5">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="w-0.5 bg-current rounded-full animate-sound-wave"
              style={{ animationDelay: `${i * 0.1}s`, height: '100%' }}
            />
          ))}
        </div>
      ) : (
        <Volume2 size={12} />
      )}
    </button>
  );
});
