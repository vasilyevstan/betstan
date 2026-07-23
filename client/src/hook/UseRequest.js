import axios from 'axios';
import { useState } from 'react';

 const UseRequest = ({url, method, body, onSuccess}) => {
    // method nust be equal  to get, post, patch
    const [errors, setErrors] = useState(null);

    const buildErrorMessages = (error) => {
        const responseErrors = error?.response?.data?.errors;
        if (Array.isArray(responseErrors) && responseErrors.length > 0) {
            return responseErrors.map((entry) => entry?.msg || entry?.message || 'Request failed');
        }

        const responseMessage = error?.response?.data?.message;
        if (typeof responseMessage === 'string' && responseMessage.trim()) {
            return [responseMessage];
        }

        if (typeof error?.message === 'string' && error.message.trim()) {
            return [error.message];
        }

        return ['Request failed'];
    };

    const doRequest = async (props = {}) => {
        try {
            setErrors(null);
            const response = await axios[method](url, {...body, ...props});

            if (onSuccess) {
                onSuccess(response.data);
            }
            return response.data;
        } catch (err) {
            const messages = buildErrorMessages(err);
            setErrors(
                <div className="alert alert-danger">
                    <h4>Ooops...</h4>
                    <ul className="my-0">
                        {messages.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
                    </ul>
                </div>
            )
        }

    };

    return { doRequest, errors };
}

export default UseRequest;