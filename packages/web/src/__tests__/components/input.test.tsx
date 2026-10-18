/**
 * Input Component Tests
 * Tests for the actual Input component implementation
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { Input } from '@/components/ui/input';

describe('Input Component', () => {
  describe('Rendering', () => {
    it('should render an input element', () => {
      render(<Input />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('should render with placeholder', () => {
      render(<Input placeholder="Enter text" />);
      expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
    });

    it('should render with label when provided', () => {
      render(<Input label="Email" />);
      expect(screen.getByText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
    });

    it('should render label with proper styling', () => {
      render(<Input label="Name" />);
      const label = screen.getByText('Name');
      expect(label).toHaveClass('text-sm');
      expect(label).toHaveClass('font-medium');
    });
  });

  describe('Input Types', () => {
    it('should render with email type', () => {
      render(<Input type="email" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('type', 'email');
    });

    it('should render with password type', () => {
      render(<Input type="password" data-testid="password" />);
      expect(screen.getByTestId('password')).toHaveAttribute('type', 'password');
    });

    it('should render with number type', () => {
      render(<Input type="number" data-testid="number" />);
      expect(screen.getByTestId('number')).toHaveAttribute('type', 'number');
    });
  });

  describe('Value Management', () => {
    it('should display initial value', () => {
      render(<Input defaultValue="Initial value" />);
      expect(screen.getByRole('textbox')).toHaveValue('Initial value');
    });

    it('should update value when typing', async () => {
      const user = userEvent.setup();
      render(<Input />);
      
      const input = screen.getByRole('textbox');
      await user.type(input, 'Hello');
      
      expect(input).toHaveValue('Hello');
    });

    it('should call onChange when value changes', async () => {
      const handleChange = jest.fn();
      const user = userEvent.setup();
      render(<Input onChange={handleChange} />);
      
      await user.type(screen.getByRole('textbox'), 'a');
      
      expect(handleChange).toHaveBeenCalled();
    });

    it('should support controlled value', () => {
      const { rerender } = render(<Input value="controlled" onChange={() => {}} />);
      expect(screen.getByRole('textbox')).toHaveValue('controlled');
      
      rerender(<Input value="updated" onChange={() => {}} />);
      expect(screen.getByRole('textbox')).toHaveValue('updated');
    });
  });

  describe('Disabled State', () => {
    it('should be disabled when disabled prop is true', () => {
      render(<Input disabled />);
      expect(screen.getByRole('textbox')).toBeDisabled();
    });

    it('should have disabled styling', () => {
      render(<Input disabled />);
      const input = screen.getByRole('textbox');
      expect(input.className).toContain('disabled:opacity-50');
      expect(input.className).toContain('disabled:cursor-not-allowed');
    });
  });

  describe('Read Only State', () => {
    it('should be read-only when readOnly prop is true', () => {
      render(<Input readOnly />);
      expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    });
  });

  describe('Error State', () => {
    it('should display error message when error prop is provided', () => {
      render(<Input error="This field is required" />);
      expect(screen.getByText('This field is required')).toBeInTheDocument();
    });

    it('should have error styling on input', () => {
      render(<Input error="Error" />);
      const input = screen.getByRole('textbox');
      expect(input.className).toContain('border-[var(--color-danger)]');
    });

    it('should show error message in red text', () => {
      render(<Input error="Invalid email" />);
      const errorText = screen.getByText('Invalid email');
      expect(errorText.className).toContain('text-[var(--color-danger)]');
    });
  });

  describe('Hint Text', () => {
    it('should display hint text when provided', () => {
      render(<Input hint="Enter your full name" />);
      expect(screen.getByText('Enter your full name')).toBeInTheDocument();
    });

    it('should not show hint when error is present', () => {
      render(<Input hint="Helpful hint" error="Error message" />);
      expect(screen.queryByText('Helpful hint')).not.toBeInTheDocument();
      expect(screen.getByText('Error message')).toBeInTheDocument();
    });
  });

  describe('Icons', () => {
    it('should render left icon when provided', () => {
      render(<Input leftIcon={<span data-testid="left-icon">🔍</span>} />);
      expect(screen.getByTestId('left-icon')).toBeInTheDocument();
    });

    it('should render right icon when provided', () => {
      render(<Input rightIcon={<span data-testid="right-icon">✓</span>} />);
      expect(screen.getByTestId('right-icon')).toBeInTheDocument();
    });

    it('should add left padding when leftIcon is present', () => {
      render(<Input leftIcon={<span>Icon</span>} />);
      expect(screen.getByRole('textbox')).toHaveClass('pl-10');
    });

    it('should add right padding when rightIcon is present', () => {
      render(<Input rightIcon={<span>Icon</span>} />);
      expect(screen.getByRole('textbox')).toHaveClass('pr-10');
    });
  });

  describe('Styling', () => {
    it('should have base input styles', () => {
      render(<Input />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('h-11');
      expect(input).toHaveClass('w-full');
      expect(input).toHaveClass('rounded-[12px]');
    });

    it('should have border styles', () => {
      render(<Input />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('border');
    });

    it('should have focus styles', () => {
      render(<Input />);
      const input = screen.getByRole('textbox');
      expect(input.className).toContain('focus:outline-none');
      expect(input.className).toContain('focus:ring-2');
    });
  });

  describe('Custom className', () => {
    it('should apply custom className', () => {
      render(<Input className="custom-input" />);
      expect(screen.getByRole('textbox')).toHaveClass('custom-input');
    });

    it('should merge with default styles', () => {
      render(<Input className="my-class" />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('my-class');
      expect(input).toHaveClass('h-11');
    });
  });

  describe('ID Generation', () => {
    it('should use provided id', () => {
      render(<Input id="my-input" label="Field" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('id', 'my-input');
    });

    it('should generate id from label when not provided', () => {
      render(<Input label="Email Address" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('id', 'email-address');
    });
  });

  describe('Ref Forwarding', () => {
    it('should forward ref to input element', () => {
      const ref = React.createRef<HTMLInputElement>();
      render(<Input ref={ref} />);
      expect(ref.current).toBeInstanceOf(HTMLInputElement);
    });

    it('should allow programmatic focus via ref', () => {
      const ref = React.createRef<HTMLInputElement>();
      render(<Input ref={ref} />);
      
      ref.current?.focus();
      expect(document.activeElement).toBe(ref.current);
    });
  });

  describe('HTML Attributes', () => {
    it('should pass through required attribute', () => {
      render(<Input required />);
      expect(screen.getByRole('textbox')).toBeRequired();
    });

    it('should pass through minLength', () => {
      render(<Input minLength={5} />);
      expect(screen.getByRole('textbox')).toHaveAttribute('minLength', '5');
    });

    it('should pass through maxLength', () => {
      render(<Input maxLength={100} />);
      expect(screen.getByRole('textbox')).toHaveAttribute('maxLength', '100');
    });

    it('should pass through pattern attribute', () => {
      render(<Input pattern="[0-9]+" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('pattern', '[0-9]+');
    });

    it('should pass through aria attributes', () => {
      render(<Input aria-describedby="help-text" />);
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-describedby', 'help-text');
    });
  });

  describe('Events', () => {
    it('should call onFocus when focused', () => {
      const handleFocus = jest.fn();
      render(<Input onFocus={handleFocus} />);
      
      fireEvent.focus(screen.getByRole('textbox'));
      expect(handleFocus).toHaveBeenCalledTimes(1);
    });

    it('should call onBlur when blurred', () => {
      const handleBlur = jest.fn();
      render(<Input onBlur={handleBlur} />);
      
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      fireEvent.blur(input);
      
      expect(handleBlur).toHaveBeenCalledTimes(1);
    });

    it('should call onKeyDown on key press', async () => {
      const handleKeyDown = jest.fn();
      const user = userEvent.setup();
      render(<Input onKeyDown={handleKeyDown} />);
      
      await user.type(screen.getByRole('textbox'), '{Enter}');
      expect(handleKeyDown).toHaveBeenCalled();
    });
  });
});
